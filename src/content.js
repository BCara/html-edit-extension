/*
 * Quick Edit — content script.
 *
 * Owns the document's original bytes and the offset map, and answers the
 * popup's requests. The editing itself lives in editor.js; this file is the
 * lifecycle and messaging layer.
 *
 * Note what is NOT done anywhere in this extension: reading the document back
 * out of the DOM with innerHTML or outerHTML. That would hand us Chrome's
 * re-serialisation of the file — tidied indentation, normalised attributes,
 * dropped comments — instead of what the user actually wrote. The file is only
 * ever produced by splicing the string fetched below.
 */
(function () {
  'use strict';

  if (window.__quickEditContentLoaded) return;
  window.__quickEditContentLoaded = true;

  var Editor = window.QuickEditEditor;

  var state = {
    source: null,     // original file text, verbatim
    map: null,        // { records, stats }
    ready: false,
  };

  /*
   * Read the file's original bytes.
   *
   * fetch() is tried first. XMLHttpRequest is kept as a fallback because
   * file:// support differs between Chrome versions and content-script worlds,
   * and an extension that cannot read the source has nothing to offer.
   *
   * Decoded as UTF-8 (the default for both APIs). A file in another encoding
   * would come back mangled; see the encoding check below.
   */
  function readSource(url) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    }).catch(function (fetchErr) {
      return new Promise(function (resolve, reject) {
        try {
          var xhr = new XMLHttpRequest();
          xhr.open('GET', url, true);
          xhr.responseType = 'text';
          xhr.onload = function () { resolve(xhr.responseText); };
          xhr.onerror = function () {
            reject(new Error('Could not read the file (' + fetchErr.message + ').'));
          };
          xhr.send();
        } catch (e) {
          reject(new Error('Could not read the file (' + fetchErr.message + ').'));
        }
      });
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

  function filename() {
    var name = decodeURIComponent(location.pathname.split('/').pop() || '');
    return name || 'page.html';
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
      var problem = encodingProblem(source);
      if (problem) throw new Error(problem);
      state.source = source;
      state.map = window.QuickEditMap.build(source, document);
      Editor.init({ source: source, map: state.map, filename: filename() });
      state.ready = true;
      console.log('[Quick Edit]', state.map.stats.editable, 'editable regions', state.map.stats);
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

    handler(msg).then(sendResponse).catch(function (err) {
      console.warn('[Quick Edit]', err);
      sendResponse({ ok: false, code: 'error', message: String(err && err.message || err) });
    });
    return true;   // response is async
  });

  console.log('[Quick Edit] ready on', location.href);
})();
