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
 * ADDING MARKUP
 * -------------
 * Two things here do write markup the file did not have, both only ever where
 * the user asked for them:
 *
 *   - Enter inside a run of text inserts a <br>.
 *   - Enter at the end of a block, Ctrl/Cmd+Enter, or the "+" that appears on
 *     hover adds an empty sibling block — another <p> after a <p>, another <li>
 *     after an <li> — carrying the same tag and class and nothing else.
 *
 * An added block is a ZERO-LENGTH splice at a known offset, so it displaces
 * nothing: every byte that was in the file is still in the file. An added block
 * left empty is not written at all, on the grounds that it was almost certainly
 * a mis-click.
 */
(function (root) {
  'use strict';

  var Islands = root.QuickEditIslands;
  var Splice = root.QuickEditSplice;
  var Blocks = root.QuickEditBlocks;
  var Comments = root.QuickEditComments;

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
    byElement: null,      // blocks we added -> their region
    add: null,            // the hover controls
    hoverBlock: null,
    comments: [],         // comment regions, existing and new
    rail: null,           // the margin the cards live in
    railRendering: false, // guards the blur fired by rebuilding the cards
    editingComment: null, // the region whose card has focus
    railStyle: null,      // the page's own inline <html> style, to put back
    history: [],
    historyAt: 0,
    lastTouch: 0,
    pendingBefore: null,
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
    // A commented section is shaded and barred, the way a word processor marks
    // one, so it is obvious which note belongs to which passage.
    ':root[data-qe-mode] [data-qe-commented] {',
    '  background: rgba(217, 160, 30, .10) !important;',
    '  box-shadow: -4px 0 0 rgba(217, 160, 30, .65) !important;',
    '}',
    ':root[data-qe-mode] [data-qe-commented][data-qe-comment-active] {',
    '  background: rgba(217, 160, 30, .2) !important;',
    '  box-shadow: -4px 0 0 rgba(217, 160, 30, 1) !important;',
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
      var r = state.regions[i];
      if (!r.removed && r.current !== r.original) n++;
    }
    return n + commentChangedCount();
  }

  function unsavedCount() {
    var n = 0;
    for (var i = 0; i < state.regions.length; i++) {
      var r = state.regions[i];
      if (!r.removed && r.current !== r.saved) n++;
    }
    return n + commentUnsavedCount();
  }

  // Added blocks the user never typed into. They are not written to the file,
  // so the status bar says so rather than letting them vanish silently.
  function emptyAddedCount() {
    var n = 0;
    for (var i = 0; i < state.regions.length; i++) {
      var r = state.regions[i];
      if (r.kind === 'insert' && !r.removed && !r.current) n++;
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
    state.byElement = new WeakMap();

    for (var i = 0; i < records.length; i++) {
      var record = records[i];
      if (!record.editable) continue;
      // The page's own scripts may have moved or removed nodes since the map
      // was built. A detached node has no place in the document any more.
      if (!record.node.parentNode) continue;

      var island = Islands.wrap(record.node);
      island.setAttribute('contenteditable', 'true');

      var region = {
        kind: 'text',
        record: record,
        island: island,
        original: record.node.data,
        current: record.node.data,
        saved: record.node.data,
      };
      state.regions.push(region);
      state.byIsland.set(island, region);
    }
  }

  /*
   * Leaving edit mode with no changes puts the DOM back exactly as it was.
   * With changes, the wrappers stay: they are holding the user's edits, and
   * `all: unset` keeps them invisible until edit mode comes back.
   */
  function teardownRegions() {
    var keep = changedCount() > 0;

    // An added block with nothing typed into it was a mis-click. It would not
    // have been written to the file either way, so take it out of the page too.
    for (var i = state.regions.length - 1; i >= 0; i--) {
      var region = state.regions[i];
      if (region.kind === 'insert' && !region.current && region.element.parentNode) {
        region.element.parentNode.removeChild(region.element);
        region.removed = true;
      }
    }

    for (var j = 0; j < state.regions.length; j++) {
      var island = state.regions[j].island;
      island.removeAttribute('contenteditable');
      if (!keep && state.regions[j].kind === 'text') Islands.unwrap(island);
    }

    if (!keep && commentChangedCount() === 0) {
      state.regions = [];
      state.byIsland = new WeakMap();
      state.byElement = new WeakMap();
      state.comments = [];
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

  // --- adding blocks ---------------------------------------------------------

  /*
   * Where a sibling of `block` would go in the file.
   *
   * A block we added ourselves is not in the file at all, so a sibling of it
   * anchors at the same offset. Several insertions can share one offset; save
   * emits them in document order, and a stable sort keeps them that way.
   */
  function anchorForBlock(block) {
    var owned = state.byElement.get(block);
    if (owned) return owned.anchor;
    return Blocks.anchorFor(state.map, state.source, block);
  }

  function canAddAfter(block) {
    return !!(block && anchorForBlock(block));
  }

  function addAfterBlock(block) {
    if (!block) { flash('There is nothing here to add another of'); return null; }

    var anchor = anchorForBlock(block);
    if (!anchor) {
      flash('Quick Edit cannot tell where this block ends in the file');
      return null;
    }

    var template = Blocks.templateFor(block);
    var element = document.createElement(template.tag);
    if (template.className) element.setAttribute('class', template.className);

    var island = document.createElement('span');
    island.setAttribute(Islands.ATTR, '');
    island.setAttribute('contenteditable', 'true');
    element.appendChild(island);
    block.parentNode.insertBefore(element, block.nextSibling);

    var region = {
      kind: 'insert',
      island: island,
      element: element,
      anchor: anchor,
      template: template,
      // Only used to carry the file's line-ending style into escaping.
      span: { raw: Blocks.newlineOf(state.source) },
      original: '',
      current: '',
      saved: '',
      removed: false,
    };
    state.regions.push(region);
    state.byIsland.set(island, region);
    state.byElement.set(element, region);

    pushHistory({ kind: 'add', region: region });

    island.focus();
    Islands.setCaret(island, 0);
    hideAdd();
    refresh();
    return region;
  }

  function addAfterIsland(island) {
    return addAfterBlock(Blocks.blockFor(island));
  }

  // True when the caret sits at the very end of the last run of text in its
  // block — the point at which Enter should start a new block rather than
  // break the line.
  function atEndOfBlock(island) {
    var value = Islands.readValue(island);
    if (Islands.caretIndex(island) !== value.length) return false;

    var block = Blocks.blockFor(island);
    if (!block) return false;

    var inBlock = block.querySelectorAll('[' + Islands.ATTR + ']');
    return inBlock.length > 0 && inBlock[inBlock.length - 1] === island;
  }

  // --- history ---------------------------------------------------------------

  // Push an entry, dropping any redo branch first.
  function pushHistory(entry) {
    if (state.historyAt < state.history.length) state.history.length = state.historyAt;
    state.history.push(entry);
    if (state.history.length > HISTORY_LIMIT) state.history.shift();
    state.historyAt = state.history.length;
    state.lastTouch = 0;
  }

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
    if (last && last.kind === 'text' && last.region === region &&
        (now - state.lastTouch) < COALESCE_MS) {
      // A run of typing in one region is one undo step, not one per keystroke.
      last.after = after;
      last.caretAfter = Islands.caretIndex(island);
    } else {
      state.history.push({
        kind: 'text',
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

  // Take an added block back out of the page, or put it back.
  function setAdded(region, present) {
    if (present === !region.removed) return;
    if (present) {
      region.parent.insertBefore(region.element, region.nextSibling);
      region.removed = false;
      region.island.focus();
    } else {
      // Remember exactly where it sat, so redo can put it back there.
      region.parent = region.element.parentNode;
      region.nextSibling = region.element.nextSibling;
      if (region.parent) region.parent.removeChild(region.element);
      region.removed = true;
    }
    state.lastTouch = 0;
    refresh();
  }

  function setCommentText(region, text) {
    region.text = text;
    region.editingFrom = undefined;
    renderRail();
    refresh();
  }

  function undo() {
    flushCommentEdit();
    if (state.historyAt === 0) { flash('Nothing to undo'); return; }
    var entry = state.history[--state.historyAt];
    if (entry.kind === 'add') setAdded(entry.region, false);
    else if (entry.kind === 'comment-add') setCommentRemoved(entry.region, true);
    else if (entry.kind === 'comment-remove') setCommentRemoved(entry.region, false);
    else if (entry.kind === 'comment-text') setCommentText(entry.region, entry.before);
    else applyHistory(entry.region, entry.before, entry.caretBefore);
  }

  function redo() {
    flushCommentEdit();
    if (state.historyAt >= state.history.length) { flash('Nothing to redo'); return; }
    var entry = state.history[state.historyAt++];
    if (entry.kind === 'add') setAdded(entry.region, true);
    else if (entry.kind === 'comment-add') setCommentRemoved(entry.region, false);
    else if (entry.kind === 'comment-remove') setCommentRemoved(entry.region, true);
    else if (entry.kind === 'comment-text') setCommentText(entry.region, entry.after);
    else applyHistory(entry.region, entry.after, entry.caretAfter);
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
      // Enter at the end of a block starts a new one; anywhere else it breaks
      // the line. Shift+Enter (insertLineBreak) always breaks the line.
      if (type === 'insertParagraph' && atEndOfBlock(island) && canAddAfter(Blocks.blockFor(island))) {
        addAfterIsland(island);
      } else {
        insertPlain(island, '\n');
      }
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
    positionCards();     // the text just reflowed; the cards follow it
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

    // Ctrl/Cmd+Enter adds a block from anywhere in it, not just the end.
    if (key === 'enter') {
      var island = islandOf(document.activeElement);
      if (island) { e.preventDefault(); addAfterIsland(island); }
      return;
    }
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

  // --- the "+" that appears on hover -----------------------------------------

  var ADD_CSS = [
    ':host { all: initial; }',
    '.row { display: flex; gap: 4px; }',
    'button {',
    '  font: 600 13px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;',
    '  width: 18px; height: 18px; padding: 0;',
    '  display: flex; align-items: center; justify-content: center;',
    '  border: 0; border-radius: 50%; cursor: pointer;',
    '  color: #fff; box-shadow: 0 1px 5px rgba(0, 0, 0, .3);',
    '  opacity: .75;',
    '}',
    'button:hover { opacity: 1; }',
    'button.block { background: #5b52f0; }',
    'button.note { background: #d9a01e; }',
    'svg { width: 10px; height: 10px; fill: currentColor; display: block; }',
  ].join('\n');

  function ensureAddButton() {
    if (state.add && state.add.host.isConnected) return state.add;

    var host = document.createElement('div');
    host.setAttribute(UI_ATTR, '');
    [['position', 'absolute'], ['z-index', '2147483646'], ['margin', '0'],
     ['padding', '0'], ['width', 'auto'], ['height', 'auto'],
     ['transform', 'none'], ['pointer-events', 'auto'], ['display', 'none'],
    ].forEach(function (p) { host.style.setProperty(p[0], p[1], 'important'); });

    var shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = '<style>' + ADD_CSS + '</style>' +
      '<div class="row">' +
        '<button class="block" title="Add another one of these">+</button>' +
        '<button class="note" title="Comment on this section">' +
          '<svg viewBox="0 0 16 16" aria-hidden="true">' +
          '<path d="M3 2h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7l-3.6 2.8V12H3a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/>' +
          '</svg>' +
        '</button>' +
      '</div>';

    shadow.querySelector('.block').addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (state.hoverBlock) addAfterBlock(state.hoverBlock);
    });
    shadow.querySelector('.note').addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (state.hoverBlock) addCommentTo(state.hoverBlock);
    });

    document.documentElement.appendChild(host);
    state.add = { host: host };
    return state.add;
  }

  function hideAdd() {
    if (state.add) state.add.host.style.setProperty('display', 'none', 'important');
    state.hoverBlock = null;
  }

  /*
   * Park the + in the gap just below the block, at its left edge. Positioned in
   * document coordinates so it stays put while the page scrolls.
   */
  function showAddFor(block) {
    var ui = ensureAddButton();
    var rect = block.getBoundingClientRect();
    if (!rect.width && !rect.height) { hideAdd(); return; }

    state.hoverBlock = block;
    ui.host.style.setProperty('left', (rect.left + window.scrollX) + 'px', 'important');
    ui.host.style.setProperty('top', (rect.bottom + window.scrollY - 9) + 'px', 'important');
    ui.host.style.setProperty('display', 'block', 'important');
  }

  function onMouseOver(e) {
    if (!state.active) return;
    if (state.add && e.target === state.add.host) return;   // over the + itself

    var island = islandOf(e.target);
    if (!island) { hideAdd(); return; }

    var block = Blocks.blockFor(island);
    if (!block || !canAddAfter(block)) { hideAdd(); return; }
    if (block !== state.hoverBlock) showAddFor(block);
  }

  var LISTENERS = [
    ['beforeinput', onBeforeInput, true],
    ['input', onInput, true],
    ['paste', onPaste, true],
    ['drop', onDrop, true],
    ['dragover', onDragOver, true],
    ['keydown', onKeyDown, true],
    ['mouseover', onMouseOver, true],
    ['click', onClick, true],
    ['submit', onSubmit, true],
  ];

  function addListeners() {
    if (state.listening) return;
    LISTENERS.forEach(function (l) { document.addEventListener(l[0], l[1], l[2]); });
    window.addEventListener('resize', onResize);
    state.listening = true;
  }

  function removeListeners() {
    if (!state.listening) return;
    LISTENERS.forEach(function (l) { document.removeEventListener(l[0], l[1], l[2]); });
    window.removeEventListener('resize', onResize);
    state.listening = false;
  }

  // --- comments --------------------------------------------------------------

  var COMMENTED_ATTR = 'data-qe-commented';
  var ACTIVE_ATTR = 'data-qe-comment-active';
  var RAIL_WIDTH = 296;

  var RAIL_CSS = [
    ':host { all: initial; }',
    '.card {',
    '  position: absolute; right: 0; width: 260px;',
    '  font: 12px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;',
    '  background: #fffdf7; color: #22242a;',
    '  border: 1px solid #e6ddc4; border-left: 3px solid #d9a01e;',
    '  border-radius: 6px; padding: 8px 9px 7px;',
    '  box-shadow: 0 1px 6px rgba(0, 0, 0, .12);',
    '  transition: top .12s ease;',
    '  box-sizing: border-box;',
    '}',
    '.card.unsaved { border-left-color: #5b52f0; }',
    '.head { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; }',
    '.who { font-weight: 600; color: #6b6250; flex: 1; }',
    '.del {',
    '  font: 14px/1 system-ui, sans-serif; border: 0; background: transparent;',
    '  color: #9a917d; cursor: pointer; padding: 0 2px; border-radius: 3px;',
    '}',
    '.del:hover { background: rgba(0, 0, 0, .07); color: #b91c1c; }',
    'textarea {',
    '  font: inherit; width: 100%; border: 0; padding: 0; margin: 0;',
    '  background: transparent; color: inherit; resize: none; overflow: hidden;',
    '  outline: none; display: block;',
    '}',
    'textarea::placeholder { color: #a9a08c; }',
    '@media (prefers-color-scheme: dark) {',
    '  .card { background: #2a2620; color: #ece9e2; border-color: #4a4133; }',
    '  .who { color: #b8ad93; }',
    '  textarea::placeholder { color: #7d7462; }',
    '}',
  ].join('\n');

  function liveComments() {
    return state.comments.filter(function (r) { return !r.removed; });
  }

  function commentChangedCount() {
    var n = 0;
    for (var i = 0; i < state.comments.length; i++) {
      var r = state.comments[i];
      if (r.removed) { if (r.token) n++; continue; }   // a deleted existing comment is a change
      if (r.text.trim() !== r.original) n++;
    }
    return n;
  }

  function commentUnsavedCount() {
    var n = 0;
    for (var i = 0; i < state.comments.length; i++) {
      var r = state.comments[i];
      if (r.removed) { if (r.token || r.saved) n++; continue; }
      if (r.text.trim() !== r.saved) n++;
    }
    return n;
  }

  function emptyCommentCount() {
    var n = 0;
    var live = liveComments();
    for (var i = 0; i < live.length; i++) if (!live[i].text.trim()) n++;
    return n;
  }

  /*
   * Comments already in the file. Anything that is not one of ours — the
   * boilerplate a generator left behind, a conditional comment — is left
   * exactly where it is and never shown.
   */
  function buildComments() {
    state.comments = [];
    var paired = state.map.comments.paired;

    for (var i = 0; i < paired.length; i++) {
      var text = Comments.textOf(paired[i].node.data);
      if (text === null) continue;
      var node = paired[i].node;
      state.comments.push({
        kind: 'comment',
        token: paired[i].token,
        node: node,
        block: node.nextElementSibling || node.parentElement,
        text: text,
        original: text,
        saved: text,
        removed: false,
        anchor: null,
        card: null,
      });
    }
  }

  function addCommentTo(block) {
    if (!block) return null;
    flushCommentEdit();
    var anchor = Comments.anchorFor(state.map, state.source, block);
    if (!anchor) {
      flash('Quick Edit cannot tell where this section starts in the file');
      return null;
    }
    var region = {
      kind: 'comment',
      token: null,
      node: null,
      block: block,
      text: '',
      original: '',
      saved: '',
      removed: false,
      anchor: anchor,
      card: null,
    };
    state.comments.push(region);
    pushHistory({ kind: 'comment-add', region: region });
    hideAdd();
    renderRail(region);
    refresh();
    return region;
  }

  function setCommentRemoved(region, removed) {
    region.removed = removed;
    renderRail();
    refresh();
  }

  function removeComment(region) {
    flushCommentEdit();
    pushHistory({ kind: 'comment-remove', region: region });
    setCommentRemoved(region, true);
  }

  // Text changes are one history step per visit to a card, not per keystroke.
  function commitCommentText(region) {
    if (region.editingFrom === undefined || region.editingFrom === region.text) {
      region.editingFrom = undefined;
      return;
    }
    pushHistory({
      kind: 'comment-text',
      region: region,
      before: region.editingFrom,
      after: region.text,
    });
    region.editingFrom = undefined;
  }

  /*
   * Settle any half-finished typing in a card before something structural
   * happens.
   *
   * Without this, adding or deleting a comment rebuilds the margin, which
   * destroys the focused textarea, which fires blur, which files the typing as
   * a history step AFTER the structural one. Undo would then take back the
   * typing instead of the deletion — the wrong thing, and confusingly so.
   */
  function flushCommentEdit() {
    if (!state.editingComment) return;
    commitCommentText(state.editingComment);
    state.editingComment = null;
  }

  // --- the comment margin ----------------------------------------------------

  /*
   * The cards live in a margin down the right-hand side, like a word processor.
   * Making room for it means widening the page's right padding while edit mode
   * is on — a visible change to the layout, but a temporary one, and the file
   * never hears about it. The page's own inline style is put back on the way
   * out.
   */
  function ensureRail() {
    if (state.rail && state.rail.host.isConnected) return state.rail;

    var html = document.documentElement;
    state.railStyle = {
      paddingRight: html.style.getPropertyValue('padding-right'),
      paddingPriority: html.style.getPropertyPriority('padding-right'),
      position: html.style.getPropertyValue('position'),
      positionPriority: html.style.getPropertyPriority('position'),
    };
    html.style.setProperty('padding-right', RAIL_WIDTH + 'px', 'important');
    // So the rail positions against the padding box rather than the viewport.
    html.style.setProperty('position', 'relative', 'important');

    var host = document.createElement('div');
    host.setAttribute(UI_ATTR, '');
    [['position', 'absolute'], ['top', '0'], ['right', '10px'],
     ['width', '260px'], ['height', '0'], ['margin', '0'], ['padding', '0'],
     ['z-index', '2147483645'], ['pointer-events', 'auto'],
    ].forEach(function (p) { host.style.setProperty(p[0], p[1], 'important'); });

    var shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = '<style>' + RAIL_CSS + '</style><div class="list"></div>';
    html.appendChild(host);

    state.rail = { host: host, shadow: shadow, list: shadow.querySelector('.list') };
    return state.rail;
  }

  function closeRail() {
    if (state.rail && state.rail.host.parentNode) {
      state.rail.host.parentNode.removeChild(state.rail.host);
    }
    state.rail = null;

    if (state.railStyle) {
      var html = document.documentElement;
      var saved = state.railStyle;
      html.style.removeProperty('padding-right');
      html.style.removeProperty('position');
      if (saved.paddingRight) {
        html.style.setProperty('padding-right', saved.paddingRight, saved.paddingPriority);
      }
      if (saved.position) {
        html.style.setProperty('position', saved.position, saved.positionPriority);
      }
      state.railStyle = null;
    }
  }

  function clearHighlights() {
    var marked = document.querySelectorAll('[' + COMMENTED_ATTR + ']');
    for (var i = 0; i < marked.length; i++) {
      marked[i].removeAttribute(COMMENTED_ATTR);
      marked[i].removeAttribute(ACTIVE_ATTR);
    }
  }

  function autoGrow(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
  }

  function renderRail(focusRegion) {
    var regions = liveComments();

    if (!regions.length) {
      state.railRendering = true;
      clearHighlights();
      closeRail();
      state.railRendering = false;
      return;
    }

    var rail = ensureRail();
    state.railRendering = true;
    rail.list.textContent = '';
    clearHighlights();

    regions.forEach(function (region) {
      var card = document.createElement('div');
      card.className = 'card' + (region.text.trim() === region.saved ? '' : ' unsaved');
      card.innerHTML =
        '<div class="head"><span class="who">Comment</span>' +
        '<button class="del" title="Delete this comment">&times;</button></div>' +
        '<textarea rows="1" placeholder="Write a comment…"></textarea>';

      var textarea = card.querySelector('textarea');
      textarea.value = region.text;

      textarea.addEventListener('input', function () {
        region.text = textarea.value;
        autoGrow(textarea);
        card.className = 'card' + (region.text.trim() === region.saved ? '' : ' unsaved');
        positionCards();
        refresh();
      });
      textarea.addEventListener('focus', function () {
        region.editingFrom = region.text;
        state.editingComment = region;
        if (region.block && region.block.setAttribute) region.block.setAttribute(ACTIVE_ATTR, '');
      });
      textarea.addEventListener('blur', function () {
        // A blur caused by rebuilding the margin is not the user finishing an
        // edit; flushCommentEdit has already dealt with any real one.
        if (state.railRendering) return;
        if (state.editingComment === region) state.editingComment = null;
        commitCommentText(region);
        if (region.block && region.block.removeAttribute) region.block.removeAttribute(ACTIVE_ATTR);
      });
      card.querySelector('.del').addEventListener('click', function () { removeComment(region); });

      rail.list.appendChild(card);
      region.card = card;
      autoGrow(textarea);

      if (region.block && region.block.setAttribute) {
        region.block.setAttribute(COMMENTED_ATTR, '');
      }
    });

    state.railRendering = false;
    positionCards();
    if (focusRegion && focusRegion.card) focusRegion.card.querySelector('textarea').focus();
  }

  /*
   * Line each card up with the section it belongs to, and push it down if the
   * one above would overlap it. Same idea as a word processor's margin: the
   * cards want to sit beside their text and settle for as close as they can get.
   */
  function positionCards() {
    if (!state.rail) return;
    var regions = liveComments();
    var bottom = 0;

    for (var i = 0; i < regions.length; i++) {
      var region = regions[i];
      if (!region.card) continue;

      var wanted = bottom;
      if (region.block && region.block.getBoundingClientRect) {
        var rect = region.block.getBoundingClientRect();
        wanted = rect.top + window.scrollY;
      }
      var top = Math.max(wanted, bottom);
      region.card.style.top = top + 'px';
      bottom = top + region.card.offsetHeight + 8;
    }
  }

  function onResize() {
    positionCards();
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
    if (state.add && state.add.host.parentNode) {
      state.add.host.parentNode.removeChild(state.add.host);
    }
    state.add = null;
    state.hoverBlock = null;
  }

  function refresh() {
    if (!state.ui) return;
    var changed = changedCount();
    var unsaved = unsavedCount();
    var empty = emptyAddedCount() + emptyCommentCount();

    var text = changed === 0
      ? 'no changes'
      : changed + (changed === 1 ? ' change' : ' changes') + (unsaved ? ' · unsaved' : ' · saved');
    if (empty) text += ' · ' + empty + ' empty' + (empty === 1 ? '' : 's') + ' not saved';

    state.ui.count.textContent = text;
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

  /*
   * Walked in DOCUMENT order rather than region order, because several added
   * blocks can share one anchor offset — a block added after a block that was
   * itself added has nowhere else to go. applyEdits sorts by offset with a
   * stable sort, so feeding them in document order is what keeps them in the
   * order they appear on screen.
   */
  function collectEdits() {
    var edits = [];
    var islands = document.querySelectorAll('[' + Islands.ATTR + ']');

    for (var i = 0; i < islands.length; i++) {
      var region = state.byIsland.get(islands[i]);
      if (!region || region.removed) continue;

      if (region.kind === 'insert') {
        // An added block nobody typed into is not written at all.
        if (!region.current) continue;
        edits.push({
          start: region.anchor.offset,
          end: region.anchor.offset,
          replacement: region.anchor.before +
            Blocks.markup(region.template, serialise(region.current, region.span)) +
            region.anchor.after,
        });
        continue;
      }

      if (region.current === region.original) continue;   // untouched: never spliced
      edits.push({
        start: region.record.span.start,
        end: region.record.span.end,
        replacement: serialise(region.current, region.record.span),
      });
    }

    collectCommentEdits(edits);
    return edits;
  }

  /*
   * Comments are ranges too: a new one is a zero-length splice before its
   * section, an edited one replaces the comment that is already there, and a
   * deleted one cuts it — taking the whole line with it if the comment had the
   * line to itself.
   *
   * A comment left empty is treated as no comment: a new one is never written,
   * and an existing one emptied out is removed.
   */
  function collectCommentEdits(edits) {
    var newline = Blocks.newlineOf(state.source);

    for (var i = 0; i < state.comments.length; i++) {
      var region = state.comments[i];
      var text = region.text.trim();

      if (region.removed || (!text && region.token)) {
        if (!region.token) continue;                 // a new one, discarded
        var cut = Comments.deleteRange(state.source, region.token);
        edits.push({ start: cut.start, end: cut.end, replacement: '' });
        continue;
      }
      if (!text) continue;                           // a new one, never written in

      if (region.token) {
        if (text === region.original) continue;      // untouched
        edits.push({
          start: region.token.start,
          end: region.token.end,
          replacement: Comments.markup(
            text, Blocks.indentOf(state.source, region.token.start), newline),
        });
        continue;
      }

      edits.push({
        start: region.anchor.offset,
        end: region.anchor.offset,
        replacement: Comments.markup(text, region.anchor.indent, newline) + region.anchor.after,
      });
    }
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

    flushCommentEdit();

    var text;
    try {
      text = preview();
    } catch (err) {
      flash('Could not save: ' + (err && err.message || err));
      return Promise.resolve();
    }

    // Captured now, applied on success: the user can keep typing while the
    // save dialog is open.
    var snapshot = state.regions.map(function (r) { return { region: r, value: r.current }; })
      .concat(state.comments.map(function (r) { return { region: r, value: r.text.trim() }; }));
    var skipped = emptyAddedCount() + emptyCommentCount();
    flash('Saving…');

    return requestDownload(text).then(function (res) {
      if (!res || !res.ok) {
        flash('Save failed: ' + ((res && res.message) || 'unknown error'));
        return;
      }
      for (var i = 0; i < snapshot.length; i++) snapshot[i].region.saved = snapshot[i].value;
      renderRail();
      refresh();

      var where = res.viaAnchor
        ? 'Saved to your Downloads folder as ' + state.filename
        : 'Saved ' + state.filename + ' — the original file is unchanged';
      flash(skipped
        ? where + ' (' + skipped + ' empty left out)'
        : where);
    });
  }

  // --- lifecycle -------------------------------------------------------------

  function setActive(next) {
    if (next === state.active) return state.active;

    if (next) {
      state.active = true;
      ensureStyles();
      if (!state.regions.length) {
        buildRegions();
        buildComments();
      } else {
        state.regions.forEach(function (r) { r.island.setAttribute('contenteditable', 'true'); });
      }
      document.documentElement.setAttribute(MODE_ATTR, 'on');
      addListeners();
      ensureStatusBar();
      renderRail();
      refresh();
      if (!state.regions.length) flash('No editable text found in this file');
    } else {
      state.active = false;
      document.documentElement.removeAttribute(MODE_ATTR);
      removeListeners();
      teardownRegions();
      clearHighlights();
      closeRail();
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
    var added = 0;
    for (var i = 0; i < state.regions.length; i++) {
      if (state.regions[i].kind === 'insert' && !state.regions[i].removed) added++;
    }
    return {
      active: state.active,
      regions: state.regions.length,
      changed: changedCount(),
      unsaved: unsavedCount(),
      added: added,
      emptyAdded: emptyAddedCount(),
      comments: liveComments().length,
      emptyComments: emptyCommentCount(),
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
    addAfterIsland: addAfterIsland,
    atEndOfBlock: atEndOfBlock,
    addCommentTo: addCommentTo,
    removeComment: removeComment,
    commentRegions: liveComments,
    setActive: setActive,
    isActive: function () { return state.active; },
    status: status,
    save: save,
    undo: undo,
    redo: redo,
  };
})(typeof self !== 'undefined' ? self : globalThis);
