/*
 * Quick Edit — content script.
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
  var VERSION = '0.3.0';
  var REQUIRED = [
    'QuickEditTokenizer', 'QuickEditMap', 'QuickEditSplice',
    'QuickEditIslands', 'QuickEditBlocks', 'QuickEditComments', 'QuickEditPrompt', 'QuickEditEditor',
  ];

  function missingModules() {
    return REQUIRED.filter(function (name) { return !window[name]; });
  }

  var SKEW_MESSAGE =
    'Quick Edit is out of step with itself. Open chrome://extensions, press ' +
    'the reload arrow on the Quick Edit card, then reload this page.';

  // A previous version left its globals in this world. Re-running would not
  // help — the stale modules are already loaded — so ask for a page reload.
  if (window.__quickEditContentLoaded) {
    if (window.__quickEditVersion !== VERSION) {
      console.warn('[Quick Edit] version ' + VERSION + ' was injected over ' +
                   window.__quickEditVersion + '. ' + SKEW_MESSAGE);
      window.__quickEditSkew = SKEW_MESSAGE;
    }
    return;
  }
  window.__quickEditContentLoaded = true;
  window.__quickEditVersion = VERSION;

  var missing = missingModules();
  if (missing.length) {
    console.error('[Quick Edit] these modules were never injected: ' +
                  missing.join(', ') + '. ' + SKEW_MESSAGE);
  }

  var Editor = window.QuickEditEditor;
  var Prompt = window.QuickEditPrompt;

  var state = {
    source: null,     // original file text, verbatim
    map: null,        // { records, stats }
    ready: false,
    readVia: null,    // which of the routes below actually worked
    readError: null,  // why the earlier ones did not
    served: null,     // for an http(s) document: how to write it back
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

  function filename() {
    var name = decodeURIComponent(location.pathname.split('/').pop() || '');
    return name || 'page.html';
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
    return fetch(url, { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      state.served = {
        url: url.split('#')[0],
        etag: r.headers.get('ETag'),
        lastModified: r.headers.get('Last-Modified'),
        canPut: false,        // decided by probeWriteBack(), below
      };
      state.readVia = 'server';
      return r.text();
    }).catch(function (err) {
      state.readError = { ok: false, code: 'served-fetch-failed', message: String(err && err.message || err) };
      console.log('[Quick Edit] could not re-fetch this document:', err && err.message);
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
    if (!state.served) return Promise.resolve();
    return fetch(state.served.url, { method: 'OPTIONS', credentials: 'same-origin' })
      .then(function (r) {
        var allow = (r.headers.get('Allow') || '') + ',' +
                    (r.headers.get('Access-Control-Allow-Methods') || '');
        state.served.canPut = /\bPUT\b/i.test(allow);
      })
      .catch(function () { /* no answer is a "no" */ });
  }

  function readSource(url) {
    if (isServed()) return readServed(url);

    return send({ type: 'quickEdit:readFile', url: url }).then(function (res) {
      if (res && res.ok) {
        state.readVia = 'service worker';
        return res.text;
      }
      state.readError = res;
      console.log('[Quick Edit] service worker could not read the file:', res);

      return fetch(url).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      }).then(function (text) {
        state.readVia = 'page fetch';
        return text;
      }).catch(function (pageErr) {
        console.log('[Quick Edit] page fetch could not read the file either:', pageErr.message);
        return chooseSource();
      });
    });
  }

  function chooseSource() {
    var wanted = filename();
    return Prompt.chooseFile({
      title: 'Quick Edit needs to read this file',
      body: 'Chrome will not let an extension open a local file on its own. ' +
            'Choose this same file and Quick Edit can get to work.',
      action: 'Choose ' + wanted,
      validate: function (file) {
        if (file.name.toLowerCase() !== wanted.toLowerCase()) {
          return 'That is ' + file.name + ', but this page is ' + wanted + '.';
        }
        return null;
      },
    }).then(function (file) {
      return file.text();
    }).then(function (text) {
      state.readVia = 'file picker';
      return text;
    });
  }

  // A file that is not UTF-8 would be decoded wrongly, and writing it back would
  // corrupt every non-ASCII character. Detect the obvious cases and refuse.
  function encodingProblem(source) {
    if (source.indexOf('\ufffd') !== -1) {
      return 'This file does not appear to be valid UTF-8. Quick Edit would corrupt it, so editing is disabled.';
    }
    var meta = /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(source.slice(0, 4096));
    if (meta) {
      var cs = meta[1].toLowerCase();
      if (cs !== 'utf-8' && cs !== 'utf8') {
        return 'This file declares charset "' + meta[1] + '". Quick Edit only handles UTF-8.';
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

  function ensureReady() {
    if (state.ready) return Promise.resolve(state);
    return domReady().then(function () {
      return readSource(location.href);
    }).then(function (source) {
      return probeWriteBack().then(function () { return source; });
    }).then(function (source) {
      var problem = encodingProblem(source);
      if (problem) throw new Error(problem);

      var map = window.QuickEditMap.build(source, document);
      var mismatch = coverageProblem(map);
      if (mismatch) throw new Error(mismatch);

      state.source = source;
      state.map = map;
      Editor.init({
        source: source, map: map, filename: filename(), served: state.served,
      });
      state.ready = true;
      console.log('[Quick Edit] read via ' + state.readVia + ' —',
                  map.stats.editable, 'editable regions', map.stats);
      return state;
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
      writeBack: state.served ? (state.served.canPut ? 'server' : 'download') : 'download',
      editor: Editor.status(),
    };
    if (extra) for (var k in extra) out[k] = extra[k];
    return out;
  }

  var HANDLERS = {
    'quickEdit:ping': function () { return Promise.resolve({ ready: true }); },

    'quickEdit:scan': function () {
      return ensureReady().then(function () { return report(); });
    },

    'quickEdit:toggle': function (msg) {
      return ensureReady().then(function () {
        Editor.setActive(typeof msg.active === 'boolean' ? msg.active : !Editor.isActive());
        return report();
      });
    },

    'quickEdit:save': function () {
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
    if (gone.length && msg.type !== 'quickEdit:ping') {
      sendResponse({ ok: false, code: 'version-skew', message: SKEW_MESSAGE, missing: gone });
      return true;
    }

    handler(msg).then(sendResponse).catch(function (err) {
      var message = String(err && err.message || err);
      console.warn('[Quick Edit]', err);
      sendResponse({
        ok: false,
        code: message === 'cancelled' ? 'cancelled' : 'error',
        message: message,
        readError: state.readError,
      });
    });
    return true;   // response is async
  });

  console.log('[Quick Edit] ready on', location.href);
})();
