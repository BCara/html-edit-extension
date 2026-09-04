/*
 * Quick Edit — edit mode.
 *
 * Turns the mapped text regions into editable islands, keeps what the user can
 * do inside them narrow enough that the markup cannot move, tracks history, and
 * writes the file out by splicing the original source.
 *
 * WHAT THE USER CAN DO
 * --------------------
 * Type, delete, cut, paste (as plain text) and press Enter. Nothing else:
 * formatting commands are refused, drops are refused, links do not navigate,
 * forms do not submit. Everything happens inside one island, which is one text
 * node, which is one range of the source file.
 *
 * THE ONE EXCEPTION TO "TEXT ONLY"
 * --------------------------------
 * Enter inserts a <br>, which is a tag the file did not have. It is written out
 * only inside a region the user actively edited, never anywhere else, and it is
 * the only markup Quick Edit can ever add. Documented in the README.
 */
(function (root) {
  'use strict';

  var Islands = root.QuickEditIslands;
  var Splice = root.QuickEditSplice;

  var UI_ATTR = 'data-quick-edit-ui';
  var MODE_ATTR = 'data-qe-mode';
  var CHANGED_ATTR = 'data-qe-changed';
  var COALESCE_MS = 700;     // typing runs merge into one undo step
  var HISTORY_LIMIT = 500;

  /*
   * The input types allowed to reach the document — a whitelist, not a
   * blacklist. Everything here only ever changes characters inside one text
   * node; anything not on the list is refused, including input types that do
   * not exist yet and the empty string Chrome hands back for ones it does not
   * recognise. Refusing an edit is recoverable; letting an unknown command
   * rewrite the markup is not.
   *
   * insertParagraph, insertLineBreak, historyUndo and historyRedo are absent
   * because they are handled explicitly before this list is consulted.
   * insertFromPaste and insertFromDrop are absent deliberately: paste is
   * intercepted at the paste event and re-inserted as plain text, and drops are
   * refused outright, so anything arriving here by those routes got past the
   * handler that was supposed to sanitise it.
   */
  var ALLOWED_INPUT = [
    'insertText',
    'insertReplacementText',      // autocorrect, spellcheck suggestions
    'insertCompositionText',      // IME composition in progress
    'insertFromComposition',
    'insertTranspose',
    'deleteContentBackward',
    'deleteContentForward',
    'deleteByCut',
    'deleteWordBackward',
    'deleteWordForward',
    'deleteSoftLineBackward',
    'deleteSoftLineForward',
    'deleteEntireSoftLine',
    'deleteHardLineBackward',
    'deleteHardLineForward',
    'deleteCompositionText',
  ];

  // Anything that is not printable text: the C0 controls (which includes the
  // U+0001 that stands for a <br> in an island's value) and DEL. Newline is
  // deliberately absent — it is handled separately, as a line break.
  var CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

  var state = {
    active: false,
    source: '',
    map: null,
    filename: 'page.html',
    regions: [],
    byIsland: null,
    history: [],
    historyAt: 0,
    lastTouch: 0,
    pendingBefore: null,
    savedValues: [],
    ui: null,
    styleEl: null,
    listening: false,
    flashTimer: 0,
  };

  /*
   * Island styling.
   *
   * `all: unset !important` is the important part: the wrapper is an element
   * the page's own stylesheet knows nothing about, and a rule like
   * `span { color: red }` would otherwise repaint the user's document the
   * moment edit mode came on. Unsetting everything makes the wrapper visually
   * nonexistent — inherited properties still inherit, everything else goes back
   * to initial — and the affordances are then added back deliberately.
   */
  var ISLAND_CSS = [
    '[data-qe-island] { all: unset !important; display: inline !important; }',
    ':root[data-qe-mode] [data-qe-island] {',
    '  cursor: text !important;',
    '  border-radius: 2px !important;',
    '}',
    ':root[data-qe-mode] [data-qe-island]:hover {',
    '  background: rgba(91, 82, 240, .09) !important;',
    '  box-shadow: 0 0 0 1px rgba(91, 82, 240, .35) !important;',
    '}',
    ':root[data-qe-mode] [data-qe-island]:focus {',
    '  outline: none !important;',
    '  background: rgba(91, 82, 240, .12) !important;',
    '  box-shadow: 0 0 0 2px rgba(91, 82, 240, .75) !important;',
    '}',
    ':root[data-qe-mode] [data-qe-island][data-qe-changed] {',
    '  background: rgba(217, 160, 30, .16) !important;',
    '}',
    // An island emptied of all its text would otherwise be impossible to click
    // back into.
    ':root[data-qe-mode] [data-qe-island]:empty {',
    '  display: inline-block !important;',
    '  min-width: .7em !important;',
    '  min-height: 1em !important;',
    '  box-shadow: 0 0 0 1px rgba(91, 82, 240, .5) !important;',
    '}',
  ].join('\n');

  var BAR_CSS = [
    ':host { all: initial; }',
    '.bar {',
    '  font: 12px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;',
    '  display: flex; align-items: center; gap: 9px;',
    '  padding: 7px 8px 7px 13px;',
    '  border-radius: 999px;',
    '  background: rgba(22, 22, 27, .93);',
    '  color: #f1f2f5;',
    '  box-shadow: 0 2px 16px rgba(0, 0, 0, .3);',
    '  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);',
    '  -webkit-user-select: none; user-select: none;',
    '}',
    '.dot { width: 7px; height: 7px; border-radius: 50%; background: #7c74ff; flex: none; }',
    '.label { white-space: nowrap; }',
    '.count { color: #a5aab8; white-space: nowrap; }',
    '.msg { color: #ffd08a; max-width: 24em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.msg:empty { display: none; }',
    'button {',
    '  font: inherit; border: 0; border-radius: 999px; padding: 4px 11px;',
    '  cursor: pointer; background: rgba(255, 255, 255, .13); color: inherit;',
    '}',
    'button:hover:not(:disabled) { background: rgba(255, 255, 255, .22); }',
    'button.primary { background: #5b52f0; }',
    'button.primary:hover:not(:disabled) { background: #6d64ff; }',
    'button:disabled { opacity: .4; cursor: default; }',
  ].join('\n');

  // --- small helpers ---------------------------------------------------------

  function islandOf(target) {
    if (!target) return null;
    var el = target.nodeType === 1 ? target : target.parentElement;
    if (!el || !el.closest) return null;
    return el.closest('[' + Islands.ATTR + ']');
  }

  function regionOf(island) {
    return island && state.byIsland ? state.byIsland.get(island) : null;
  }

  function changedCount() {
    var n = 0;
    for (var i = 0; i < state.regions.length; i++) {
      if (state.regions[i].current !== state.regions[i].original) n++;
    }
    return n;
  }

  function unsavedCount() {
    var n = 0;
    for (var i = 0; i < state.regions.length; i++) {
      if (state.regions[i].current !== state.savedValues[i]) n++;
    }
    return n;
  }

  function sanitiseText(text) {
    return String(text).replace(/\r\n?/g, '\n').replace(CONTROL_RE, '');
  }

  // --- islands ---------------------------------------------------------------

  function buildRegions() {
    var records = state.map.records;
    state.regions = [];
    state.byIsland = new WeakMap();

    for (var i = 0; i < records.length; i++) {
      var record = records[i];
      if (!record.editable) continue;
      // The page's own scripts may have moved or removed nodes since the map
      // was built. A detached node has no place in the document any more.
      if (!record.node.parentNode) continue;

      var island = Islands.wrap(record.node);
      island.setAttribute('contenteditable', 'true');

      var region = {
        record: record,
        island: island,
        original: record.node.data,
        current: record.node.data,
      };
      state.regions.push(region);
      state.byIsland.set(island, region);
    }
    state.savedValues = state.regions.map(function (r) { return r.current; });
  }

  /*
   * Leaving edit mode with no changes puts the DOM back exactly as it was.
   * With changes, the wrappers stay: they are holding the user's edits, and
   * `all: unset` keeps them invisible until edit mode comes back.
   */
  function teardownRegions() {
    var keep = changedCount() > 0;
    for (var i = 0; i < state.regions.length; i++) {
      var island = state.regions[i].island;
      island.removeAttribute('contenteditable');
      if (!keep) Islands.unwrap(island);
    }
    if (!keep) {
      state.regions = [];
      state.byIsland = new WeakMap();
      state.history = [];
      state.historyAt = 0;
    }
  }

  function markChanged(region) {
    if (region.current !== region.original) region.island.setAttribute(CHANGED_ATTR, '');
    else region.island.removeAttribute(CHANGED_ATTR);
  }

  // The browser or a stray paste can leave elements inside an island. Flatten
  // them back to text and <br>, keeping the words and the caret.
  function flatten(island) {
    var caret = Islands.caretIndex(island);
    Islands.writeValue(island, Islands.readValue(island));
    if (caret != null) Islands.setCaret(island, caret);
  }

  // --- history ---------------------------------------------------------------

  function recordChange(island, explicitBefore, explicitCaret) {
    var region = regionOf(island);
    if (!region) return;

    var after = Islands.readValue(island);
    if (after === region.current) return;

    var before = explicitBefore !== undefined ? explicitBefore : region.current;
    var caretBefore = explicitCaret !== undefined ? explicitCaret
      : (state.pendingBefore ? state.pendingBefore.caret : null);
    var now = Date.now();

    // A fresh edit abandons anything that was waiting to be redone.
    if (state.historyAt < state.history.length) state.history.length = state.historyAt;

    var last = state.history[state.history.length - 1];
    if (last && last.region === region && (now - state.lastTouch) < COALESCE_MS) {
      // A run of typing in one region is one undo step, not one per keystroke.
      last.after = after;
      last.caretAfter = Islands.caretIndex(island);
    } else {
      state.history.push({
        region: region,
        before: before,
        after: after,
        caretBefore: caretBefore,
        caretAfter: Islands.caretIndex(island),
      });
      if (state.history.length > HISTORY_LIMIT) state.history.shift();
      state.historyAt = state.history.length;
    }

    state.lastTouch = now;
    region.current = after;
    markChanged(region);
    refresh();
  }

  function applyHistory(region, value, caret) {
    Islands.writeValue(region.island, value);
    region.current = value;
    markChanged(region);
    state.lastTouch = 0;          // never coalesce across an undo or redo
    region.island.focus();
    if (caret != null) Islands.setCaret(region.island, caret);
    refresh();
  }

  function undo() {
    if (state.historyAt === 0) { flash('Nothing to undo'); return; }
    var entry = state.history[--state.historyAt];
    applyHistory(entry.region, entry.before, entry.caretBefore);
  }

  function redo() {
    if (state.historyAt >= state.history.length) { flash('Nothing to redo'); return; }
    var entry = state.history[state.historyAt++];
    applyHistory(entry.region, entry.after, entry.caretAfter);
  }

  // --- input handling --------------------------------------------------------

  function onBeforeInput(e) {
    var island = islandOf(e.target);
    if (!island || !state.active) return;
    var type = e.inputType || '';

    if (type === 'historyUndo') { e.preventDefault(); undo(); return; }
    if (type === 'historyRedo') { e.preventDefault(); redo(); return; }

    if (type === 'insertParagraph' || type === 'insertLineBreak') {
      e.preventDefault();
      insertPlain(island, '\n');
      return;
    }

    if (ALLOWED_INPUT.indexOf(type) === -1) {
      e.preventDefault();
      if (type.lastIndexOf('format', 0) === 0) {
        // Bold, italic, colours, indentation, alignment: all of it would mean
        // new markup or new attributes, which is exactly what Quick Edit does
        // not do.
        flash('Quick Edit changes words, not formatting');
      } else if (type === 'insertFromDrop') {
        flash('Drag and drop is not supported — copy and paste instead');
      } else {
        flash('That kind of edit is not supported in Quick Edit');
      }
      return;
    }

    // Ordinary typing and deleting. Remember where we were so the change can be
    // turned into an undo step once it has happened.
    state.pendingBefore = {
      region: regionOf(island),
      value: Islands.readValue(island),
      caret: Islands.caretIndex(island),
    };
  }

  function onInput(e) {
    var island = islandOf(e.target);
    if (!island || !state.active) return;
    if (!Islands.isClean(island)) flatten(island);

    var pending = state.pendingBefore;
    var matches = pending && pending.region === regionOf(island);
    state.pendingBefore = null;
    recordChange(island,
                 matches ? pending.value : undefined,
                 matches ? pending.caret : undefined);
  }

  function insertPlain(island, text) {
    var doc = island.ownerDocument;
    var sel = doc.getSelection();
    if (!sel || !sel.rangeCount) return;

    var range = sel.getRangeAt(0);
    if (!island.contains(range.commonAncestorContainer)) return;

    var before = Islands.readValue(island);
    var caretBefore = Islands.caretIndex(island);

    range.deleteContents();

    var pieces = sanitiseText(text).split('\n');
    var frag = doc.createDocumentFragment();
    for (var i = 0; i < pieces.length; i++) {
      if (i) frag.appendChild(doc.createElement('br'));
      if (pieces[i]) frag.appendChild(doc.createTextNode(pieces[i]));
    }
    var last = frag.lastChild;
    range.insertNode(frag);

    if (last) {
      range.setStartAfter(last);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    recordChange(island, before, caretBefore);
  }

  function onPaste(e) {
    if (!state.active) return;
    var island = islandOf(e.target);
    if (!island) return;
    // Always intercept: the clipboard usually carries text/html as well, and
    // letting the browser have it would paste tags straight into the document.
    e.preventDefault();
    var text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    insertPlain(island, text);
  }

  function onDrop(e) {
    if (!state.active) return;
    e.preventDefault();
    flash('Drag and drop is not supported — copy and paste instead');
  }

  function onDragOver(e) {
    if (state.active) e.preventDefault();
  }

  function onKeyDown(e) {
    if (!state.active) return;
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    var key = (e.key || '').toLowerCase();

    if (key === 's') { e.preventDefault(); save(); return; }
    if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if ((key === 'z' && e.shiftKey) || key === 'y') { e.preventDefault(); redo(); return; }
  }

  // Following a link would throw away every unsaved edit, and the page is a
  // document being edited, not a site being browsed.
  function onClick(e) {
    if (!state.active) return;
    var el = e.target && e.target.nodeType === 1 ? e.target : null;
    var link = el && el.closest ? el.closest('a[href]') : null;
    if (link && (link.getAttribute('href') || '').charAt(0) !== '#') {
      e.preventDefault();
      flash('Links do not navigate while edit mode is on');
    }
  }

  function onSubmit(e) {
    if (!state.active) return;
    e.preventDefault();
    flash('Forms do not submit while edit mode is on');
  }

  function onBeforeUnload(e) {
    if (!unsavedCount()) return;
    e.preventDefault();
    e.returnValue = '';
    return '';
  }

  var LISTENERS = [
    ['beforeinput', onBeforeInput, true],
    ['input', onInput, true],
    ['paste', onPaste, true],
    ['drop', onDrop, true],
    ['dragover', onDragOver, true],
    ['keydown', onKeyDown, true],
    ['click', onClick, true],
    ['submit', onSubmit, true],
  ];

  function addListeners() {
    if (state.listening) return;
    LISTENERS.forEach(function (l) { document.addEventListener(l[0], l[1], l[2]); });
    state.listening = true;
  }

  function removeListeners() {
    if (!state.listening) return;
    LISTENERS.forEach(function (l) { document.removeEventListener(l[0], l[1], l[2]); });
    state.listening = false;
  }

  // --- status bar ------------------------------------------------------------

  function ensureStyles() {
    if (state.styleEl && state.styleEl.isConnected) return;
    var el = document.createElement('style');
    el.setAttribute(UI_ATTR, '');
    el.textContent = ISLAND_CSS;
    (document.head || document.documentElement).appendChild(el);
    state.styleEl = el;
  }

  /*
   * The status bar lives in a closed shadow root so the page's stylesheet
   * cannot reach into it and our styles cannot leak out. The host element's own
   * positioning is set inline with !important, since that is the one part a
   * page rule could still fight over.
   */
  function ensureStatusBar() {
    if (state.ui && state.ui.host.isConnected) return;

    var host = document.createElement('div');
    host.setAttribute(UI_ATTR, '');
    [['position', 'fixed'], ['right', '16px'], ['bottom', '16px'],
     ['z-index', '2147483647'], ['margin', '0'], ['padding', '0'],
     ['width', 'auto'], ['height', 'auto'], ['max-width', 'none'],
     ['transform', 'none'], ['opacity', '1'], ['visibility', 'visible'],
     ['display', 'block'], ['pointer-events', 'auto'], ['float', 'none'],
    ].forEach(function (p) { host.style.setProperty(p[0], p[1], 'important'); });

    var shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML =
      '<style>' + BAR_CSS + '</style>' +
      '<div class="bar">' +
        '<span class="dot"></span>' +
        '<span class="label">Edit mode</span>' +
        '<span class="count"></span>' +
        '<span class="msg"></span>' +
        '<button class="save primary" disabled>Save</button>' +
        '<button class="done">Done</button>' +
      '</div>';

    document.documentElement.appendChild(host);

    var ui = {
      host: host,
      count: shadow.querySelector('.count'),
      msg: shadow.querySelector('.msg'),
      save: shadow.querySelector('.save'),
      done: shadow.querySelector('.done'),
    };
    ui.save.addEventListener('click', function () { save(); });
    ui.done.addEventListener('click', function () { setActive(false); });
    state.ui = ui;
  }

  function removeStatusBar() {
    if (state.ui && state.ui.host.parentNode) state.ui.host.parentNode.removeChild(state.ui.host);
    state.ui = null;
  }

  function refresh() {
    if (!state.ui) return;
    var changed = changedCount();
    var unsaved = unsavedCount();
    state.ui.count.textContent = changed === 0
      ? 'no changes'
      : changed + (changed === 1 ? ' change' : ' changes') + (unsaved ? ' · unsaved' : ' · saved');
    state.ui.save.disabled = unsaved === 0;
  }

  function flash(message) {
    if (!state.ui) return;
    state.ui.msg.textContent = message;
    clearTimeout(state.flashTimer);
    state.flashTimer = setTimeout(function () {
      if (state.ui) state.ui.msg.textContent = '';
    }, 3000);
  }

  // --- saving ----------------------------------------------------------------

  /*
   * An island's value becomes source text: each run escaped for its context,
   * each <br> written as a literal <br>. `replacementFor` also restores the
   * file's line-ending style, which the DOM does not preserve.
   */
  function serialise(value, span) {
    return value.split(Islands.BR).map(function (piece) {
      return Splice.replacementFor(span, piece);
    }).join('<br>');
  }

  function collectEdits() {
    var edits = [];
    for (var i = 0; i < state.regions.length; i++) {
      var region = state.regions[i];
      if (region.current === region.original) continue;   // untouched: never spliced
      edits.push({
        start: region.record.span.start,
        end: region.record.span.end,
        replacement: serialise(region.current, region.record.span),
      });
    }
    return edits;
  }

  function send(message) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(message, function (res) {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, message: chrome.runtime.lastError.message });
          } else {
            resolve(res || { ok: false, message: 'No response from the extension.' });
          }
        });
      } catch (err) {
        resolve({ ok: false, message: String(err && err.message || err) });
      }
    });
  }

  function toDataUrl(text) {
    var bytes = new TextEncoder().encode(text);
    var binary = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return 'data:text/html;charset=utf-8;base64,' + btoa(binary);
  }

  /*
   * Hand the file to the downloads API, which is the only way to get the OS
   * Save dialog — and therefore the only way the user can choose to replace the
   * original. Two fallbacks, because a service worker cannot create object URLs
   * of its own and support for reaching a page's blob: URL has moved around
   * between Chrome versions:
   *   1. a blob: URL created here
   *   2. a data: URL, which needs no cross-context resolution
   *   3. an ordinary download link in the page — no dialog, so the file lands in
   *      the Downloads folder and the status bar says so
   */
  function requestDownload(text) {
    var blobUrl = URL.createObjectURL(new Blob([text], { type: 'text/html;charset=utf-8' }));

    return send({ type: 'quickEdit:download', url: blobUrl, filename: state.filename })
      .then(function (res) {
        setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 60000);
        if (res && res.ok) { console.log('[Quick Edit] saved via blob URL'); return res; }
        console.warn('[Quick Edit] blob URL download failed, trying a data URL:', res && res.message);
        return send({ type: 'quickEdit:download', url: toDataUrl(text), filename: state.filename });
      })
      .then(function (res) {
        if (res && res.ok) { console.log('[Quick Edit] saved via data URL'); return res; }
        console.warn('[Quick Edit] downloads API unavailable, falling back to a download link:',
                     res && res.message);
        var a = document.createElement('a');
        a.setAttribute(UI_ATTR, '');
        a.href = URL.createObjectURL(new Blob([text], { type: 'text/html;charset=utf-8' }));
        a.download = state.filename;
        a.style.setProperty('display', 'none', 'important');
        document.documentElement.appendChild(a);
        a.click();
        setTimeout(function () {
          URL.revokeObjectURL(a.href);
          if (a.parentNode) a.parentNode.removeChild(a);
        }, 60000);
        return { ok: true, viaAnchor: true };
      });
  }

  /*
   * The exact bytes that would be saved right now: the original source with
   * only the changed regions spliced. With no changes this returns the source
   * itself, unchanged, which is the guarantee the whole extension rests on.
   */
  function preview() {
    return Splice.applyEdits(state.source, collectEdits());
  }

  function save() {
    if (!state.regions.length) { flash('Nothing to save'); return Promise.resolve(); }

    var text;
    try {
      text = preview();
    } catch (err) {
      flash('Could not save: ' + (err && err.message || err));
      return Promise.resolve();
    }

    var snapshot = state.regions.map(function (r) { return r.current; });
    flash('Saving…');

    return requestDownload(text).then(function (res) {
      if (!res || !res.ok) {
        flash('Save failed: ' + ((res && res.message) || 'unknown error'));
        return;
      }
      state.savedValues = snapshot;
      refresh();
      flash(res.viaAnchor
        ? 'Saved to your Downloads folder as ' + state.filename
        : 'Saved ' + state.filename + ' — the original file is unchanged');
    });
  }

  // --- lifecycle -------------------------------------------------------------

  function setActive(next) {
    if (next === state.active) return state.active;

    if (next) {
      state.active = true;
      ensureStyles();
      if (!state.regions.length) buildRegions();
      else state.regions.forEach(function (r) { r.island.setAttribute('contenteditable', 'true'); });
      document.documentElement.setAttribute(MODE_ATTR, 'on');
      addListeners();
      ensureStatusBar();
      refresh();
      if (!state.regions.length) flash('No editable text found in this file');
    } else {
      state.active = false;
      document.documentElement.removeAttribute(MODE_ATTR);
      removeListeners();
      teardownRegions();
      removeStatusBar();
      // The stylesheet stays: any wrappers left holding unsaved edits still need
      // `all: unset` to remain invisible.
    }

    send({ type: 'quickEdit:state', active: state.active, unsaved: unsavedCount() });
    return state.active;
  }

  function init(options) {
    state.source = options.source;
    state.map = options.map;
    state.filename = options.filename || 'page.html';
    // Registered once and left in place: unsaved edits still exist after edit
    // mode is switched off, and losing them to a stray navigation would be the
    // worst thing this extension could do.
    window.addEventListener('beforeunload', onBeforeUnload);
  }

  function status() {
    return {
      active: state.active,
      regions: state.regions.length,
      changed: changedCount(),
      unsaved: unsavedCount(),
      canUndo: state.historyAt > 0,
      canRedo: state.historyAt < state.history.length,
    };
  }

  root.QuickEditEditor = {
    init: init,
    // Exposed for the test suite: `preview` is the file that would be written,
    // and `serialise` decides what text lands in it. Both are worth testing
    // directly rather than through a download.
    preview: preview,
    serialise: serialise,
    setActive: setActive,
    isActive: function () { return state.active; },
    status: status,
    save: save,
    undo: undo,
    redo: redo,
  };
})(typeof self !== 'undefined' ? self : globalThis);
