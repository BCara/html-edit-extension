/*
 * VibeRevise — content script.
 *
 * Owns the document's original bytes and the offset map, and answers the
 * popup's requests. The editing itself lives in editor.js; this file is the
 * lifecycle, the file read, and the messaging layer.
 *
 * Note what is NOT done anywhere in this extension: reading the document back
 * out of the DOM with innerHTML or outerHTML. That would hand us Chrome's
 * re-serialisation of the file — tidied indentation, normalised attributes,
 * dropped comments — instead of what the user actually wrote. The file is only
 * ever produced by splicing the string read below.
 */
(function () {
  'use strict';

  /*
   * Version skew guard.
   *
   * Chrome reads content-script files from disk at injection time, but the
   * service worker's list of which files to inject is baked into the worker.
   * Update the folder without reloading the extension and you get new files
   * injected by an old list — some modules simply never arrive, and the first
   * symptom is a TypeError on whichever global is missing. Check up front and
   * say what actually needs doing.
   */
  var VERSION = '0.17.0';
  var REQUIRED = [
    'VibeReviseTokenizer', 'VibeReviseMap', 'VibeReviseSplice',
    'VibeReviseIslands', 'VibeReviseBlocks', 'VibeReviseStructures',
    'VibeReviseComments', 'VibeRevisePrompt', 'VibeReviseAI', 'VibeReviseRebase', 'VibeReviseEditor',
  ];

  function missingModules() {
    return REQUIRED.filter(function (name) { return !window[name]; });
  }

  var SKEW_MESSAGE =
    'VibeRevise is out of step with itself. Open chrome://extensions, press ' +
    'the reload arrow on the VibeRevise card, then reload this page.';

  // A previous version left its globals in this world. Re-running would not
  // help — the stale modules are already loaded — so ask for a page reload.
  if (window.__vibeReviseContentLoaded) {
    if (window.__vibeReviseVersion !== VERSION) {
      console.warn('[VibeRevise] version ' + VERSION + ' was injected over ' +
                   window.__vibeReviseVersion + '. ' + SKEW_MESSAGE);
      window.__vibeReviseSkew = SKEW_MESSAGE;
    }
    return;
  }
  window.__vibeReviseContentLoaded = true;
  window.__vibeReviseVersion = VERSION;

  var missing = missingModules();
  if (missing.length) {
    console.error('[VibeRevise] these modules were never injected: ' +
                  missing.join(', ') + '. ' + SKEW_MESSAGE);
  }

  var Editor = window.VibeReviseEditor;
  var Prompt = window.VibeRevisePrompt;
  var Origins = window.VibeReviseOrigins;

  var state = {
    source: null,     // original file text, verbatim
    map: null,        // { records, stats }
    ready: false,
    readVia: null,    // which of the routes below actually worked
    readError: null,  // why the earlier ones did not
    served: null,     // for an http(s) document: how to write it back
    reading: null,    // the in-flight read, so two messages cannot start two
    // Set only when the user chose the file through showOpenFilePicker, which
    // is the one route that can also write to it. See saveThroughHandle().
    handle: null,
    // The last handle we held, kept after the live one is dropped. Only ever
    // used to tell a picker where to open, so losing write access to a file
    // does not also lose the knowledge of which folder it was in.
    near: null,
    kind: null,             // 'file' | 'lan' | 'copy', from origins.js
    canWriteFile: false,    // Save can write, once it has asked where
  };

  function send(message) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(message, function (res) {
          if (chrome.runtime.lastError) resolve({ ok: false, message: chrome.runtime.lastError.message });
          else resolve(res || { ok: false, message: 'No response from the extension.' });
        });
      } catch (err) {
        resolve({ ok: false, message: String(err && err.message || err) });
      }
    });
  }

  // The name the user types, and whether comments are shown in the document,
  // live in extension storage, so they are the same on every document.
  var SETTINGS = {
    get: function (key) {
      return chrome.storage.local.get(key).then(function (o) { return o[key]; });
    },
    set: function (key, value) {
      var o = {};
      o[key] = value;
      return chrome.storage.local.set(o);
    },
  };

  /*
   * The editing session, kept through a reload: another tool may rewrite the
   * file, and reloading to see it must not throw away unsaved edits. Kept in
   * extension storage on this device only, under the document's address, and
   * never sent anywhere. The newest few are kept, for two weeks at most.
   */
  var SESSION_KEEP = 8;
  function sessionKey() { return 'session:' + location.href.split('#')[0]; }
  var SESSION = {
    load: function () {
      var key = sessionKey();
      return chrome.storage.local.get(key).then(function (o) { return o[key] || null; });
    },
    save: function (snap) {
      var key = sessionKey();
      var o = {};
      o[key] = snap;
      return chrome.storage.local.set(o).then(function () {
        return chrome.storage.local.get('sessions');
      }).then(function (got) {
        var list = (got.sessions || []).filter(function (s) { return s.key !== key; });
        list.unshift({ key: key, at: snap.at });
        var drop = list.slice(SESSION_KEEP).map(function (s) { return s.key; });
        var p = drop.length ? chrome.storage.local.remove(drop) : Promise.resolve();
        return p.then(function () { return chrome.storage.local.set({ sessions: list.slice(0, SESSION_KEEP) }); });
      });
    },
    clear: function () {
      var key = sessionKey();
      return chrome.storage.local.remove(key).then(function () {
        return chrome.storage.local.get('sessions');
      }).then(function (got) {
        return chrome.storage.local.set({ sessions: (got.sessions || []).filter(function (s) { return s.key !== key; }) });
      });
    },
  };

  /*
   * What the file holds now, for noticing that another program has changed
   * it. Through the handle when there is one (cheap: the text is only read
   * again when the file's modified time moves), else the way it was read.
   * Null when it cannot be told, which the editor takes as "no news".
   */
  var lastLook = { modified: null, size: null, text: null };
  var WATCH = {
    read: function () {
      if (state.handle) {
        return state.handle.getFile().then(function (file) {
          if (file.lastModified === lastLook.modified && file.size === lastLook.size && lastLook.text != null) {
            return lastLook.text;
          }
          return file.text().then(function (text) {
            lastLook = { modified: file.lastModified, size: file.size, text: text };
            return text;
          });
        }).catch(function () { return null; });
      }
      if (isServed()) {
        return fetch(location.href, { cache: 'no-store', credentials: 'same-origin' })
          .then(function (r) { return r.ok ? r.text() : null; })
          .catch(function () { return null; });
      }
      return send({ type: 'vibeRevise:readFile', url: location.href })
        .then(function (res) { return res && res.ok ? res.text : null; });
    },
    // The page has to show the new file, and only a reload does that here.
    // The session is already kept, marked to carry straight on.
    bringIn: function () { location.reload(); },
    bringInLabel: 'Reload to bring them in',
  };

  /*
   * AI, through the service worker. This script never sees the key: it asks
   * whether AI is set up, sends the prompt the editor built, and gets back the
   * answer. The settings page is the extension's options page, because only an
   * extension page may ask Chrome for permission to reach the provider.
   */
  var AI_HOST = {
    status: function () { return send({ type: 'vibeRevise:aiStatus' }); },
    complete: function (request) { return send({ type: 'vibeRevise:aiComplete', request: request }); },
    openSettings: function () { send({ type: 'vibeRevise:openOptions' }); },
  };

  // A name changed in the popup reaches a page that is already open, and so
  // does a key added on the settings page.
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !state.ready) return;
      if (changes.ai) Editor.aiSettingsChanged();
      if (!changes.author) return;
      var next = changes.author.newValue || '';
      if (Editor.status().author !== next) Editor.setAuthor(next);
    });
  }

  /*
   * What to call the file this document would be saved as.
   *
   * For a local file or a served document that is a file, the last path
   * segment is its name and that is that. A hosted page may have no last
   * segment at all (example.com/) or one with no extension
   * (example.com/docs/getting-started), so the host and the path are used to
   * build something a person will recognise in their Downloads folder, with
   * .html on the end because that is what it is.
   */
  function filename() {
    return Origins.downloadName(location.href);
  }

  // A page on the open web: edited the same way, but the result is a file the
  // user now has, never a write to somebody else's server.
  function isCopy() {
    if (state.kind === null) state.kind = Origins.classify(location.href).kind;
    return state.kind === 'copy';
  }

  /*
   * Read the file's original bytes. Three routes, in order of how little they
   * ask of the user:
   *
   *   1. The service worker fetches it with the extension's own privileges.
   *      Needs the optional file:///* host permission, which the popup offers
   *      to request.
   *
   *   2. This content script fetches it. Almost always fails, and it is worth
   *      being precise about why: in Manifest V3 a content script's fetch
   *      carries the PAGE's origin, and a file:// page may not read file://
   *      URLs. It only works if Chrome was started with
   *      --allow-file-access-from-files. Tried anyway because it costs nothing.
   *
   *   3. Ask the user to choose the file. Needs no permission of any kind and
   *      therefore always works, at the cost of one click.
   *
   * Decoded as UTF-8 in every case.
   */
  function isServed() {
    return location.protocol === 'http:' || location.protocol === 'https:';
  }

  /*
   * Read a document served over http(s).
   *
   * This is the easy case, and it is worth being clear about why, because the
   * file:// path below goes to considerable trouble for the same result. A
   * content script's fetch carries the PAGE's origin. For a file:// page that
   * origin may not read file:// URLs, hence the service worker. For an http
   * page the origin is the server the page came from, and fetching your own URL
   * is the most ordinary same-origin request there is. No permission, no
   * service worker, no user gesture.
   *
   * The cache mode is deliberately left at its default rather than forced to
   * 'no-store'. The browser already has the response it parsed into this page;
   * a default fetch will reuse or revalidate exactly that, which is what we
   * want. Forcing a fresh network read would risk picking up a NEWER version of
   * the document than the one on screen, and quietly mapping offsets onto text
   * the user cannot see. If it happens anyway — someone saved the file between
   * load and edit — coverageProblem() catches it.
   *
   * The validators are kept so the write-back can be conditional: see PUT in
   * editor.js. Without them a save could silently clobber someone else's edit.
   */
  function readServed(url) {
    /*
     * The second request for a page the browser has already fetched.
     *
     * On your own server that is nothing: ask again, get the same bytes. On
     * somebody else's it can matter, because some URLs are not idempotent —
     * a sign-in link, a confirm or unsubscribe link, a one-time download. A
     * second credentialed GET can consume or trigger one of those.
     *
     * force-cache asks the browser for the copy it already has, which is both
     * the right bytes (the ones it parsed into this page) and no request at
     * all when it has them. It is not a guarantee — a no-store response still
     * goes to the network — so this narrows the window rather than closing it,
     * and the limitation is written down in the README rather than implied
     * away here.
     */
    var opts = { credentials: 'same-origin' };
    if (isCopy()) opts.cache = 'force-cache';
    return fetch(url, opts).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      // state.served is the write-back route, so a public page does not get
      // one. Reading is identical; it is only saving that differs.
      state.served = Origins.mayWriteBack(state.kind) ? {
        url: url.split('#')[0],
        etag: r.headers.get('ETag'),
        lastModified: r.headers.get('Last-Modified'),
        canPut: false,        // decided by probeWriteBack(), below
      } : null;
      state.readVia = 'server';
      return r.text();
    }).catch(function (err) {
      state.readError = { ok: false, code: 'served-fetch-failed', message: String(err && err.message || err) };
      console.log('[VibeRevise] could not re-fetch this document:', err && err.message);
      return chooseSource();
    });
  }

  /*
   * Does this server accept a write-back?
   *
   * Asked once, with OPTIONS, so the status bar can offer "Save to server"
   * honestly instead of discovering at save time that it cannot. A server that
   * does not answer, or does not list PUT, simply gets the download path — no
   * error, nothing to configure.
   */
  function probeWriteBack() {
    // Belt and braces: state.served is already null for a public page, and
    // this says so again, because an OPTIONS request to somebody else's site
    // asking whether we may overwrite it is not a thing to do by accident.
    if (!state.served || !Origins.mayWriteBack(state.kind)) return Promise.resolve();
    return fetch(state.served.url, { method: 'OPTIONS', credentials: 'same-origin' })
      .then(function (r) {
        // See origins.js — the Allow header is the capability statement, and
        // Access-Control-Allow-Methods emphatically is not.
        state.served.canPut = Origins.acceptsWriteBack(r.headers);
      })
      .catch(function () { /* no answer is a "no" */ });
  }

  function readSource(url) {
    if (isServed()) return readServed(url);

    return send({ type: 'vibeRevise:readFile', url: url }).then(function (res) {
      if (res && res.ok) {
        state.readVia = 'service worker';
        return res.text;
      }
      state.readError = res;
      console.log('[VibeRevise] service worker could not read the file: ' + JSON.stringify(res));

      return fetch(url).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      }).then(function (text) {
        state.readVia = 'page fetch';
        return text;
      }).catch(function (pageErr) {
        console.log('[VibeRevise] page fetch could not read the file either:', pageErr.message);
        return chooseSource();
      });
    });
  }

  function chooseSource() {
    var wanted = filename();
    return Prompt.chooseFile({
      title: 'VibeRevise needs to read this file',
      body: 'Chrome will not let an extension open a local file on its own. ' +
            'Choose this same file and VibeRevise can get to work.' +
            (Prompt.canHandle
              ? ' Saving will then write straight back to it, rather than '
                + 'downloading a copy.'
              : ''),
      file: wanted,
      action: 'Choose this file',
      validate: function (file) {
        if (file.name.toLowerCase() !== wanted.toLowerCase()) {
          return 'That is ' + file.name + ', but this page is ' + wanted + '.';
        }
        return null;
      },
    }).then(function (chosen) {
      // Held for saving. A file chosen this way can be written back to, so the
      // click the user has just spent is worth more than one read.
      state.handle = chosen.handle;
      state.near = chosen.handle || state.near;
      return chosen.file.text();
    }).then(function (text) {
      state.readVia = 'file picker';
      return text;
    });
  }

  /*
   * Saving over the top of the file the user opened.
   *
   * This exists only on the picker route, and that is not a limitation anyone
   * chose: Chrome will not let an extension open a local file by itself, and
   * it will not let one write to a local file either. What it does allow is a
   * handle the user granted by hand. So the prompt that used to cost a click
   * and buy a single read now buys writing as well, and Save stops meaning
   * "download another copy to the Downloads folder".
   *
   * Returns null when there is no handle or the browser will not grant write
   * permission, and the editor then falls back to the download exactly as
   * before — the saved edits are never riding on this working.
   */
  function saveThroughHandle() {
    // A document on your own server writes back over HTTP; the handle has no
    // part in it. A copy of somebody else's page is going to a file, so it
    // does: Save asks once where to put it, and every save after that goes to
    // the same file, which is what makes editing-then-handing-it-on bearable.
    if (isServed() && !isCopy()) return Promise.resolve(null);
    // Write access to a chosen file is asked for at the first Save, not now.
    // Chrome only grants it in answer to a click, and opening the file is
    // no longer that click by the time we get here: asking now was refused
    // every time, and the handle was thrown away for it.
    return Promise.resolve(state.handle || Prompt.canHandle ? writeFn() : null);
  }

  /*
   * Save, through a handle, asking for one the first time if we do not have it.
   *
   * The ask is deferred on purpose. When the file was read by the service
   * worker there was no picker at open time, and interrupting someone before
   * they have typed a word to arrange something they have not asked for yet is
   * the wrong moment. By the time they press Save they have decided the file
   * matters, and a save dialog is what they would have got anyway — except
   * this one is the LAST one, because the handle is kept for the session.
   */
  function writeFn() {
    // opts.as: Save as — choose somewhere new, and keep saving there after.
    return function (text, opts) {
      var where = opts && opts.as ? askForHandle() : ensureHandle();
      return where.then(function (handle) {
        if (!handle) {
          // Cancelled. Not a failure, and deliberately not a fallback: nobody
          // who just dismissed a save dialog wants the file downloaded anyway.
          return { ok: false, message: 'Save cancelled' };
        }
        return Prompt.writeThrough(handle, text).then(function () {
          return { ok: true, inPlace: true, where: 'Saved over ' + filename() };
        });
      }).catch(function (err) {
        // Losing the handle mid-session — the file moved, the permission
        // lapsed — must not lose the edits with it. fallback:true tells the
        // editor to download instead of reporting a dead end.
        console.warn('[VibeRevise] writing through the handle failed:', err);
        state.near = state.handle || state.near;   // where to reopen, at least
        state.handle = null;
        return { ok: false, fallback: true, message: err && err.message || String(err) };
      });
    };
  }

  // The handle we already have, or one the user picks now. Null if they
  // cancel, which is an answer rather than an error.
  function ensureHandle() {
    if (state.handle) {
      return Prompt.canWrite(state.handle).then(function (allowed) {
        if (allowed) return state.handle;
        state.near = state.handle;      // still useful as a starting point
        state.handle = null;
        return askForHandle();
      });
    }
    return askForHandle();
  }

  function askForHandle() {
    return Prompt.saveAs(filename(), state.near).then(function (handle) {
      state.handle = handle;
      state.near = handle || state.near;
      return handle;
    });
  }

  // A file that is not UTF-8 would be decoded wrongly, and writing it back would
  // corrupt every non-ASCII character. Detect the obvious cases and refuse.
  function encodingProblem(source) {
    if (source.indexOf('\ufffd') !== -1) {
      return 'This file does not appear to be valid UTF-8. VibeRevise would corrupt it, so editing is disabled.';
    }
    var meta = /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(source.slice(0, 4096));
    if (meta) {
      var cs = meta[1].toLowerCase();
      if (cs !== 'utf-8' && cs !== 'utf8') {
        return 'This file declares charset "' + meta[1] + '". VibeRevise only handles UTF-8.';
      }
    }
    return null;
  }

  /*
   * Sanity check on the source we ended up with.
   *
   * If the user picked the wrong file, or the page rewrote itself after loading,
   * the source and the DOM will not line up and almost nothing will verify.
   * Rather than present a document where three paragraphs out of forty happen to
   * be editable, say so.
   */
  function coverageProblem(map) {
    var candidates = 0;
    var mapped = 0;
    for (var i = 0; i < map.records.length; i++) {
      var r = map.records[i];
      if (r.editable) { candidates++; mapped++; continue; }
      if (r.reason === 'whitespace' || r.reason === 'blocked-ancestor' ||
          r.reason === 'raw-text' || r.reason === 'merged-spans') continue;
      candidates++;
    }
    if (candidates === 0 || mapped / candidates >= 0.5) return null;

    /*
     * On the open web this is the ordinary case rather than a malfunction, and
     * it deserves a sentence that says so. A page built in the browser serves
     * a near-empty shell; the text on screen was never in the file, so there
     * is nothing for VibeRevise to edit and no amount of retrying will help.
     */
    if (isCopy()) {
      return 'This page is built in the browser, so the file the server sent has ' +
             'almost none of this text in it — only ' + mapped + ' of ' + candidates +
             ' regions line up. VibeRevise works on pages whose text is in the HTML: ' +
             'documentation, articles, and most server-rendered sites.';
    }
    return 'This file does not match the page — only ' + mapped + ' of ' + candidates +
           ' text regions line up. If you chose the file by hand, check it is the ' +
           'same one; otherwise the page may have rewritten itself after loading.';
  }

  // The map is only meaningful once the parser has finished building the tree.
  // Mapping a half-parsed document would leave everything after the current
  // insertion point unmatched, and therefore quietly uneditable.
  function domReady() {
    if (document.readyState !== 'loading') return Promise.resolve();
    return new Promise(function (resolve) {
      document.addEventListener('DOMContentLoaded', function () { resolve(); }, { once: true });
    });
  }

  /*
   * Read the file and build the map, once.
   *
   * The in-flight promise is held, not just the finished flag. The popup sends
   * inspect and then toggle in quick succession; both used to arrive before
   * state.ready was set, both started a read, and both put up a card asking the
   * user to choose the file. Answering one started the editor and left the
   * other on screen for ever, with nothing left to dismiss it.
   */
  function ensureReady() {
    if (state.ready) return Promise.resolve(state);
    if (state.reading) return state.reading;

    state.reading = startReading();
    // A failed read must not poison later attempts: the user may have simply
    // cancelled the picker, and the next click should ask again.
    state.reading.catch(function () { state.reading = null; });
    return state.reading;
  }

  function startReading() {
    state.kind = Origins.classify(location.href).kind;
    return domReady().then(function () {
      return readSource(location.href);
    }).then(function (source) {
      return probeWriteBack().then(function () { return source; });
    }).then(function (source) {
      var problem = encodingProblem(source);
      if (problem) throw new Error(problem);

      var map = window.VibeReviseMap.build(source, document);
      var mismatch = coverageProblem(map);
      if (mismatch) throw new Error(mismatch);

      state.source = source;
      state.map = map;
      return saveThroughHandle().then(function (saveFile) {
        Editor.init({
          source: source, map: map, filename: filename(), served: state.served,
          settings: SETTINGS,
          ai: AI_HOST,
          session: SESSION,
          watch: WATCH,
          // Non-null whenever this browser can write a file at all: Save then
          // writes over the top of the file rather than downloading a copy,
          // asking once for somewhere to write if it does not already know.
          saveFile: saveFile,
        });
        return saveFile;
      }).then(function (saveFile) {
        // Whether Save CAN write the file. Whether it already knows which file
        // is state.handle, and that may only be answered at the first save.
        state.canWriteFile = !!saveFile;
        state.ready = true;
        // Someone who has just chosen the file wants to edit it: no second
        // trip to the popup for Start editing.
        if (state.readVia === 'file picker' && !Editor.isActive()) {
          state.autoStarted = true;
          Editor.setActive(true);
        }
        console.log('[VibeRevise] read via ' + state.readVia + ' —',
                    map.stats.editable, 'editable regions', map.stats,
                    state.handle ? '— Save writes over the file'
                      : state.canWriteFile ? '— Save will ask once where to write'
                      : '');
        return state;
      });
    });
  }

  function report(extra) {
    var reasons = {};
    for (var i = 0; i < state.map.records.length; i++) {
      var r = state.map.records[i];
      if (!r.editable) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
    }
    var out = {
      ok: true,
      filename: filename(),
      bytes: state.source.length,
      stats: state.map.stats,
      reasons: reasons,
      readVia: state.readVia,
      // Derived, never stored. It used to be a flag set when a handle was
      // acquired and never cleared when one was lost, so after a failed write
      // the popup went on claiming the file was being saved in place while
      // every save was quietly going to the Downloads folder instead. A status
      // panel that lies is worse than no status panel.
      writeBack: state.handle ? 'file'
        : state.canWriteFile ? 'file-ask'
        : state.served ? (state.served.canPut ? 'server' : 'download') : 'download',
      editor: Editor.status(),
    };
    if (extra) for (var k in extra) out[k] = extra[k];
    return out;
  }

  var HANDLERS = {
    'vibeRevise:ping': function () { return Promise.resolve({ ready: true }); },

    'vibeRevise:scan': function () {
      return ensureReady().then(function () { return report(); });
    },

    'vibeRevise:toggle': function (msg) {
      var started = state.autoStarted;
      return ensureReady().then(function () {
        // Choosing the file just started editing; the press that led to it
        // was asking for exactly that, so it must not switch it off again.
        if (state.autoStarted && !started) return report();
        Editor.setActive(typeof msg.active === 'boolean' ? msg.active : !Editor.isActive());
        return report();
      });
    },

    'vibeRevise:save': function () {
      return ensureReady().then(function () {
        return Editor.save();
      }).then(function () { return report(); });
    },
  };

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string') return;
    var handler = HANDLERS[msg.type];
    if (!handler) return;

    // Answer skew with an explanation rather than letting it surface as a
    // TypeError from whichever module happens to be missing.
    var gone = missingModules();
    if (gone.length && msg.type !== 'vibeRevise:ping') {
      sendResponse({ ok: false, code: 'version-skew', message: SKEW_MESSAGE, missing: gone });
      return true;
    }

    handler(msg).then(sendResponse).catch(function (err) {
      var message = String(err && err.message || err);
      console.warn('[VibeRevise]', err);
      sendResponse({
        ok: false,
        code: message === 'cancelled' ? 'cancelled' : 'error',
        message: message,
        readError: state.readError,
      });
    });
    return true;   // response is async
  });

  console.log('[VibeRevise] ready on', location.href);
})();
