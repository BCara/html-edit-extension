/*
 * VibeRevise — edit mode.
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
 *   - Enter inserts a <br>. It stays inside the block it was pressed in: a
 *     paragraph gets a new line, not a new paragraph.
 *   - Enter at the end of a list item, Ctrl/Cmd+Enter, or the "+" that appears
 *     on hover adds an empty sibling block — another <p> after a <p>, another
 *     <li> after an <li> — carrying the same tag and class and nothing else.
 *
 * An added block is a ZERO-LENGTH splice at a known offset, so it displaces
 * nothing: every byte that was in the file is still in the file. An added block
 * left empty is not written at all, on the grounds that it was almost certainly
 * a mis-click.
 */
(function (root) {
  'use strict';

  var Islands = root.VibeReviseIslands;
  var Splice = root.VibeReviseSplice;
  var Blocks = root.VibeReviseBlocks;
  var Comments = root.VibeReviseComments;
  var Structures = root.VibeReviseStructures;

  var UI_ATTR = 'data-viberevise-ui';
  var MODE_ATTR = 'data-vr-mode';
  var CHANGED_ATTR = 'data-vr-changed';
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

  /*
   * The document being edited.
   *
   * In the extension that is the page the content script was injected into, so
   * it is the global `document` and always has been. In the web app it is an
   * iframe holding the user's file, and the editor is running in the app's
   * document instead — a different window entirely. Everything below goes
   * through these two rather than the globals, because the editor does not
   * necessarily run inside the document it edits.
   *
   * The libraries never needed this: mapping.build() already takes a document,
   * and islands.js, blocks.js and structures.js work off ownerDocument.
   */
  function doc() { return state.doc || document; }
  function win() {
    return state.win || (state.doc && state.doc.defaultView) || window;
  }

  var state = {
    active: false,
    doc: null,            // the document being edited; null means this one
    win: null,
    settings: null,       // host storage: { get(key), set(key, value) }
    author: '',           // the name the user typed, self-declared
    assist: null,         // the layer holding the AI chip, AI card, changes list
    nudgedName: false,    // suggested adding a name once already
    source: '',
    map: null,
    filename: 'page.html',
    regions: [],
    trees: [],            // inserted structures: one tree, many editable cells
    byIsland: null,
    byElement: null,      // blocks we added -> their region
    add: null,            // the hover controls
    hoverBlock: null,
    lastIsland: null,     // the island the caret was last in, for Insert
    addHideTimer: 0,      // grace period while the pointer crosses to the buttons
    comments: [],         // comment regions, existing and new
    // Whether a saved comment is written as a visible note or as an HTML
    // comment no browser shows. Remembered between sessions, because it is a
    // statement about how someone works rather than about one document.
    commentsVisible: false,
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
    '[data-vr-island] { all: unset !important; display: inline !important; }',
    ':root[data-vr-mode] [data-vr-island] {',
    '  cursor: text !important;',
    '  border-radius: 2px !important;',
    '}',
    ':root[data-vr-mode] [data-vr-island]:hover {',
    '  background: rgba(91, 82, 240, .09) !important;',
    '  box-shadow: 0 0 0 1px rgba(91, 82, 240, .35) !important;',
    '}',
    ':root[data-vr-mode] [data-vr-island]:focus {',
    '  outline: none !important;',
    '  background: rgba(91, 82, 240, .12) !important;',
    '  box-shadow: 0 0 0 2px rgba(91, 82, 240, .75) !important;',
    '}',
    ':root[data-vr-mode] [data-vr-island][data-vr-changed] {',
    '  background: rgba(217, 160, 30, .16) !important;',
    '}',
    // A commented section is shaded and barred, the way a word processor marks
    // one, so it is obvious which note belongs to which passage.
    ':root[data-vr-mode] [data-vr-commented] {',
    '  background: rgba(217, 160, 30, .10) !important;',
    '  box-shadow: -4px 0 0 rgba(217, 160, 30, .65) !important;',
    '}',
    ':root[data-vr-mode] [data-vr-commented][data-vr-comment-active] {',
    '  background: rgba(217, 160, 30, .2) !important;',
    '  box-shadow: -4px 0 0 rgba(217, 160, 30, 1) !important;',
    '}',
    // An island emptied of all its text would otherwise be impossible to click
    // back into.
    ':root[data-vr-mode] [data-vr-island]:empty {',
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
    '  position: relative;',
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
    // Undo and redo are used far more often than Save, and always as a pair,
    // so they get the compact treatment and sit together behind a divider.
    'button.icon { padding: 4px 8px; font-size: 14px; line-height: 1; }',
    '.sep { width: 1px; align-self: stretch; margin: 2px 1px; background: rgba(255, 255, 255, .16); flex: none; }',
    // The count reads as text but opens the list of changes.
    'button.count { background: transparent; padding: 4px 6px; color: #a5aab8; }',
    'button.count:hover:not(:disabled) { background: rgba(255, 255, 255, .1); color: #f1f2f5; }',
    '.panel[hidden] { display: none; }',
    '.panel {',
    '  position: absolute; bottom: calc(100% + 8px); right: 0;',
    '  width: 290px; max-width: calc(100vw - 32px); box-sizing: border-box;',
    '  padding: 12px; display: flex; flex-direction: column; gap: 7px;',
    '  border-radius: 12px; background: rgba(22, 22, 27, .97);',
    '  box-shadow: 0 4px 22px rgba(0, 0, 0, .42);',
    '}',
    '.p-label { font-weight: 600; }',
    '.p-head { display: flex; align-items: center; gap: 8px; }',
    '.p-title { font-weight: 600; flex: 1; }',
    // Detail is one press away rather than always on screen: the panel is for
    // doing something, and four lines of explanation above the controls makes
    // it something to read instead.
    '.p-info {',
    '  flex: none; width: 19px; height: 19px; padding: 0; border-radius: 50%;',
    '  font: 600 11px/1 ui-serif, Georgia, serif; font-style: italic;',
    '  background: rgba(255, 255, 255, .13); color: #c6cbd6;',
    '}',
    '.p-info:hover, .p-info[aria-expanded="true"] { background: #d9a01e; color: #231d10; }',
    '.p-row { display: flex; gap: 6px; }',
    '.p-input {',
    '  font: inherit; flex: 1 1 auto; min-width: 0; box-sizing: border-box;',
    '  padding: 6px 9px; border-radius: 7px; border: 1px solid rgba(255, 255, 255, .2);',
    '  background: rgba(255, 255, 255, .07); color: inherit;',
    '}',
    '.p-input:focus { outline: 2px solid #7c74ff; outline-offset: 0; }',
    '.p-hint { color: #9aa0ad; font-size: 11px; line-height: 1.45; }',
    '.p-sep { height: 1px; background: rgba(255, 255, 255, .12); margin: 2px 0; }',
    '.p-check {',
    '  display: flex; align-items: center; gap: 7px;',
    '  font-weight: 600; cursor: pointer;',
    '}',
    '.p-check input { flex: none; margin: 0; accent-color: #d9a01e; cursor: pointer; }',
    '.p-changes { text-align: left; border-radius: 7px; }',
    // The bar's comment button wears the same bubble as the one beside a
    // paragraph, so the two are recognisably the same thing in two places.
    'button.icon svg { width: 14px; height: 14px; fill: currentColor; display: block; }',
    // The insert menu opens upward: the bar is pinned to the bottom right, so
    // there is never room below it and always room above.
    '.menu[hidden] { display: none; }',
    '.menu {',
    '  position: absolute; bottom: calc(100% + 8px); right: 0;',
    '  min-width: 168px; padding: 5px;',
    '  display: flex; flex-direction: column; gap: 2px;',
    '  border-radius: 11px;',
    '  background: rgba(22, 22, 27, .97);',
    '  box-shadow: 0 4px 22px rgba(0, 0, 0, .42);',
    '}',
    '.menu button {',
    '  border-radius: 7px; padding: 7px 10px; text-align: left;',
    '  background: transparent; white-space: nowrap;',
    '}',
    '.menu button:hover:not(:disabled) { background: rgba(255, 255, 255, .16); }',
    '.menu .hint {',
    '  padding: 4px 10px 6px; color: #8f95a3; font-size: 11px; max-width: 20em;',
    '  white-space: normal;',
    '}',
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
    // A structure counts once, however many empty cells it has.
    for (var t = 0; t < state.trees.length; t++) {
      if (!state.trees[t].removed && !treeHasText(state.trees[t])) n++;
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
      flash('VibeRevise cannot tell where this block ends in the file');
      return null;
    }

    var template = Blocks.templateFor(block);
    var element = doc().createElement(template.tag);
    if (template.className) element.setAttribute('class', template.className);

    var island = doc().createElement('span');
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

  /*
   * The block a new structure should go after: whatever the user is in, then
   * whatever they are hovering, then the last block we can find an anchor for.
   * Never nothing — the toolbar should not fail for want of a destination.
   */
  function currentBlock() {
    /*
     * Where the caret is, or was.
     *
     * activeElement alone is not enough: pressing Insert moves focus to the
     * toolbar, so by the time this runs the caret is no longer in the text the
     * user was editing, and the answer would be whatever the document happened
     * to end with. The last island focused is the one they mean.
     */
    var island = islandOf(doc().activeElement);
    if (!island && state.lastIsland && state.lastIsland.isConnected) {
      island = state.lastIsland;
    }
    if (island) {
      var block = Blocks.blockFor(island);
      if (block && canAddAfter(block)) return block;
    }
    if (state.hoverBlock && canAddAfter(state.hoverBlock)) return state.hoverBlock;

    var islands = doc().querySelectorAll('[' + Islands.ATTR + ']');
    for (var i = islands.length - 1; i >= 0; i--) {
      var b = Blocks.blockFor(islands[i]);
      if (b && canAddAfter(b)) return b;
    }
    return null;
  }

  /*
   * Add a structure — a table, a list, a heading — after the current block.
   *
   * Unlike addAfterBlock, which owns one element holding one run of text, this
   * owns a small tree holding several. The bookkeeping is arranged so the rest
   * of the editor does not have to know the difference:
   *
   *   - each editable cell gets an ordinary region (kind 'cell'), so typing,
   *     changed-marking, undo and the unsaved count work unaltered
   *   - one tree region owns the anchor and the markup, and is shaped enough
   *     like an added block that setAdded() moves it in and out for undo
   *
   * collectEdits skips the cells; collectStructureEdits emits the tree once.
   */
  function insertStructure(id, where) {
    var block = where || currentBlock();
    if (!block) { flash('VibeRevise cannot tell where to put that in the file'); return null; }

    var anchor = anchorForBlock(block);
    if (!anchor) { flash('VibeRevise cannot tell where this block ends in the file'); return null; }

    var built = Structures.build(document, id, block);
    if (!built) { flash('VibeRevise does not know how to add that'); return null; }

    block.parentNode.insertBefore(built.element, block.nextSibling);

    var tree = {
      kind: 'tree',
      id: id,
      element: built.element,
      island: built.islands[0],     // the one setAdded() puts the caret back in
      islands: built.islands,
      anchor: anchor,
      // The indent of the line the structure starts on, so its inner lines can
      // be laid out relative to it.
      indent: anchor.before.replace(/^[\r\n]+/, ''),
      cells: [],
      removed: false,
    };

    for (var i = 0; i < built.islands.length; i++) {
      var isl = built.islands[i];
      var cell = {
        kind: 'cell',
        island: isl,
        tree: tree,
        // Carries the file's line-ending style into escaping, as for any region.
        span: { raw: Blocks.newlineOf(state.source) },
        original: '',
        current: '',
        saved: '',
        removed: false,
      };
      tree.cells.push(cell);
      state.regions.push(cell);
      state.byIsland.set(isl, cell);
    }

    state.trees.push(tree);
    // So adding a sibling to the structure itself anchors in the same place.
    state.byElement.set(built.element, tree);

    pushHistory({ kind: 'add', region: tree });

    tree.island.focus();
    Islands.setCaret(tree.island, 0);
    hideAdd();
    refresh();

    var what = Structures.kindById(id);
    flash(built.donor
      ? 'Added a ' + what.label.toLowerCase() + ' like the one above'
      : 'Added a plain ' + what.label.toLowerCase() + ' — this document had none to copy');
    return tree;
  }

  // Has anything been typed into this structure at all?
  function treeHasText(tree) {
    for (var i = 0; i < tree.cells.length; i++) {
      if (tree.cells[i].current) return true;
    }
    return false;
  }

  // A bullet or a numbered item — the one block Enter carries on from.
  function isListItem(block) {
    return !!block && block.localName === 'li';
  }

  // True when the caret sits at the very end of the last run of text in its
  // block — the point at which Enter in a list item starts the next one rather
  // than breaking the line.
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
    region.by = authorName();
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
    else if (entry.kind === 'remove-added') setAdded(entry.region, true);
    else if (entry.kind === 'multi') applyMulti(entry, false);
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
    else if (entry.kind === 'remove-added') setAdded(entry.region, false);
    else if (entry.kind === 'multi') applyMulti(entry, true);
    else if (entry.kind === 'comment-add') setCommentRemoved(entry.region, false);
    else if (entry.kind === 'comment-remove') setCommentRemoved(entry.region, true);
    else if (entry.kind === 'comment-text') setCommentText(entry.region, entry.after);
    else applyHistory(entry.region, entry.after, entry.caretAfter);
  }

  // --- input handling --------------------------------------------------------

  function onBeforeInput(e) {
    // Forged input is the serious one: it would put the page's words into the
    // document and record them as something the user typed.
    if (!fromUser(e)) return;
    var island = islandOf(e.target);
    if (!island || !state.active) return;
    var type = e.inputType || '';

    if (type === 'historyUndo') { e.preventDefault(); undo(); return; }
    if (type === 'historyRedo') { e.preventDefault(); redo(); return; }

    if (type === 'insertParagraph' || type === 'insertLineBreak') {
      e.preventDefault();
      // Enter breaks the line, the way a paragraph of prose wants it. The one
      // exception is a list item, where the next thing after finishing a bullet
      // is the next bullet. Every other kind of block gets a sibling from
      // Ctrl/Cmd+Enter or the "+" instead, which is explicit enough not to
      // surprise anyone mid-sentence.
      var block = Blocks.blockFor(island);
      if (type === 'insertParagraph' && isListItem(block) &&
          atEndOfBlock(island) && canAddAfter(block)) {
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
        // new markup or new attributes, which is exactly what VibeRevise does
        // not do.
        flash('VibeRevise changes words, not formatting');
      } else if (type === 'insertFromDrop') {
        flash('Drag and drop is not supported — copy and paste instead');
      } else {
        flash('That kind of edit is not supported in VibeRevise');
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
    if (!fromUser(e)) return;
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
    if (!state.active || !fromUser(e)) return;
    var island = islandOf(e.target);
    if (!island) return;
    // Always intercept: the clipboard usually carries text/html as well, and
    // letting the browser have it would paste tags straight into the document.
    e.preventDefault();
    var text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    insertPlain(island, text);
  }

  function onDrop(e) {
    if (!state.active || !fromUser(e)) return;
    e.preventDefault();
    flash('Drag and drop is not supported — copy and paste instead');
  }

  function onDragOver(e) {
    if (state.active) e.preventDefault();
  }

  /*
   * Something just inserted that has had nothing typed into it yet.
   *
   * Inserting is a guess about what the user wanted, and the guess is wrong
   * often enough that backing out of it has to be as cheap as making it. So
   * while a new thing is still empty, Esc and the delete keys mean "not that"
   * rather than "edit nothing". Once a single character is in it the keys go
   * back to their ordinary jobs, because by then it is the user's content.
   *
   * Only the newest insertion qualifies, and only while it is still the last
   * thing that happened: anything else and this would delete a table the user
   * had merely clicked into.
   */
  function pendingInsert() {
    var entry = state.history[state.historyAt - 1];
    if (!entry || entry.kind !== 'add' || entry.region.removed) return null;

    var region = entry.region;
    var empty = region.kind === 'tree' ? !treeHasText(region) : !region.current;
    if (!empty) return null;

    var island = islandOf(doc().activeElement);
    var here = island && state.byIsland.get(island);
    if (!here) return null;
    return (here === region || here.tree === region) ? region : null;
  }

  /*
   * The added item the caret is in, if nothing has been typed into it — the
   * whole of it, for a table: one empty cell in a table with words elsewhere
   * is not an empty table. A line break on its own is not text.
   *
   * Unlike pendingInsert(), any added item qualifies, however long ago it was
   * added: the user can click into an empty paragraph they added earlier and
   * press Delete to be rid of it. What never qualifies is anything that came
   * from the file — those regions are kind 'text', not 'insert' or 'cell' —
   * so no key press here can remove a single byte of the original document.
   */
  function blank(value) {
    return !value || !value.split(Islands.BR).join('').trim();
  }

  function emptyAddedHere() {
    var island = islandOf(doc().activeElement);
    var here = island && state.byIsland.get(island);
    if (!here) return null;
    var item = here.kind === 'insert' ? here : here.kind === 'cell' ? here.tree : null;
    if (!item || item.removed) return null;
    var empty = item.kind === 'tree'
      ? item.cells.every(function (c) { return blank(c.current); })
      : blank(item.current);
    return empty ? item : null;
  }

  // The editable island just before `el` in the document, for the caret to
  // land in once `el` is gone; failing that, the first one after it.
  function islandBeside(el) {
    var islands = doc().querySelectorAll('[' + Islands.ATTR + ']');
    var before = null, after = null;
    for (var i = 0; i < islands.length; i++) {
      var isl = islands[i];
      if (el.contains(isl) || !isl.isConnected) continue;
      if (el.compareDocumentPosition(isl) & Node.DOCUMENT_POSITION_PRECEDING) before = isl;
      else if (!after) after = isl;
    }
    return before || after;
  }

  /*
   * Take an empty added item out, as its own undoable step. The newest one
   * goes through undo(), so history does not keep an add and its removal
   * side by side for nothing; an older one is removed with an entry of its
   * own, so Ctrl/Cmd+Z brings it back exactly where it was.
   */
  function removeAdded(item) {
    var land = islandBeside(item.element);
    if (pendingInsert() === item) {
      undo();
    } else {
      setAdded(item, false);
      pushHistory({ kind: 'remove-added', region: item });
      refresh();
    }
    if (land) {
      land.focus();
      Islands.setCaret(land, Islands.readValue(land).length);
    }
    flash('Removed the ' + insertName(item) + ' \u2014 Ctrl/Cmd+Z brings it back');
  }

  function insertName(region) {
    if (region.kind !== 'tree') return region.template ? describeTag(region.template.tag) : 'new block';
    var what = Structures.kindById(region.id);
    return what ? what.label.toLowerCase() : 'new block';
  }

  /*
   * Did a person do this, or did the page?
   *
   * Every listener below is on the document, which page script can reach and
   * dispatch to whatever world the editor itself runs in. isTrusted is false
   * for anything dispatchEvent produced, and that is the only thing telling
   * the two apart.
   *
   * It did not matter while VibeRevise only opened documents the user wrote.
   * It matters now that it opens pages they did not: without this, a page can
   * forge Ctrl+S and raise a Save dialog nobody asked for, forge Ctrl+Z to
   * undo work, or forge beforeinput to put its own words into the document and
   * have them recorded as the user's edit — which the user would then save.
   *
   * state.trustSynthetic exists because the test suite can only produce
   * synthetic events. It is never set by the extension or the web app, and the
   * suite tests the guard itself with it off, so the hatch does not quietly
   * become the only path anyone exercises.
   */
  function fromUser(e) {
    return !!(e && (e.isTrusted || state.trustSynthetic));
  }

  function onKeyDown(e) {
    if (!state.active || !fromUser(e)) return;

    // Esc closes the insert menu, and is checked before the modifier gate
    // below because it carries no modifier.
    if (e.key === 'Escape' &&
        (isMenuOpen() || isAddMenuOpen() || isMoreOpen() || isChangesOpen())) {
      e.preventDefault();
      setMenuOpen(false);
      setMoreOpen(false);
      if (isAddMenuOpen()) { setAddMenuOpen(false); hideAdd(); }
      closeChanges();
      return;
    }

    // Delete and Backspace remove any empty added item the caret is in.
    if (e.key === 'Backspace' || e.key === 'Delete') {
      var empty = emptyAddedHere();
      if (empty) {
        e.preventDefault();
        removeAdded(empty);
        return;
      }
    }

    // Esc means "not that", so it only ever cancels the thing just inserted —
    // never an older one the user has come back to. Through undo(), so a
    // mistaken press is itself undoable.
    if (e.key === 'Escape') {
      var fresh = pendingInsert();
      if (fresh) {
        e.preventDefault();
        undo();
        flash('Removed the ' + insertName(fresh));
        return;
      }
    }

    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    var key = (e.key || '').toLowerCase();

    if (key === 's') { e.preventDefault(); save(); return; }
    if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if ((key === 'z' && e.shiftKey) || key === 'y') { e.preventDefault(); redo(); return; }

    // Ctrl/Cmd+Enter adds a block from anywhere in it, not just the end.
    if (key === 'enter') {
      var island = islandOf(doc().activeElement);
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

  var ADD_BTN = 24;   // button size
  var ADD_GAP = 8;    // breathing room between the buttons and the text

  var ADD_CSS = [
    ':host { all: initial; }',
    '.row { display: flex; gap: 5px; }',
    // In the margin the pair stacks, so it needs one button's width, not two.
    '.row.stack { flex-direction: column; }',
    // Sitting over the text is the fallback, so there it carries its own backing.
    '.row.over {',
    '  background: #fff; border-radius: 11px; padding: 3px;',
    '  box-shadow: 0 1px 6px rgba(0, 0, 0, .3);',
    '}',
    'button {',
    '  font: 600 15px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;',
    '  width: 24px; height: 24px; padding: 0;',
    '  display: flex; align-items: center; justify-content: center;',
    '  border: 0; border-radius: 8px; cursor: pointer;',
    '  color: #fff;',
    // A white ring, so they read against a dark page as well as a light one.
    '  box-shadow: 0 0 0 2px #fff, 0 1px 3px rgba(0, 0, 0, .28);',
    '  transition: transform .09s ease, filter .09s ease;',
    '}',
    '.row.over button { box-shadow: none; }',
    'button:hover { filter: brightness(1.12); transform: translateY(-1px); }',
    'button:active { transform: none; }',
    'button:focus-visible { outline: 2px solid #5b52f0; outline-offset: 2px; }',
    // The + opens the list of everything that can go here, because "what do I
    // want" is the question someone actually has when they reach for it. The
    // one-click repeat of what is already there is still worth its own button,
    // but it is a specific answer, so it gets a specific icon rather than the
    // most general symbol on the row.
    'button.more { background: #5b52f0; }',
    'button.block { background: #6b7280; }',
    'button.note { background: #d9a01e; }',
    // Pressed, the + holds the menu open and should look it.
    'button.more[aria-expanded="true"] { background: #4038d6; transform: none; }',
    '.menu[hidden] { display: none; }',
    '.menu {',
    '  position: absolute; left: 100%; top: 0; margin-left: 7px;',
    '  min-width: 166px; padding: 5px; z-index: 1;',
    '  display: flex; flex-direction: column; gap: 2px;',
    '  border-radius: 10px;',
    '  background: rgba(22, 22, 27, .97);',
    '  box-shadow: 0 4px 22px rgba(0, 0, 0, .42);',
    '  font: 12px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;',
    '}',
    '.menu button {',
    '  width: auto; height: auto; border-radius: 7px; padding: 7px 10px;',
    '  justify-content: flex-start; text-align: left; white-space: nowrap;',
    '  background: transparent; box-shadow: none; font-weight: 400;',
    '  font-size: 12px;',
    '}',
    '.menu button:hover { background: rgba(255, 255, 255, .16); filter: none; }',
    '.menu .sep { height: 1px; margin: 3px 4px; background: rgba(255,255,255,.14); }',
    '.menu .same { font-weight: 600; }',
    'svg { width: 13px; height: 13px; fill: currentColor; display: block; }',
    '.menu button svg { display: none; }',
  ].join('\n');

  function ensureAddButton() {
    if (state.add && state.add.host.isConnected) return state.add;

    var host = doc().createElement('div');
    host.setAttribute(UI_ATTR, '');
    [['position', 'absolute'], ['z-index', '2147483646'], ['margin', '0'],
     ['padding', '0'], ['width', 'auto'], ['height', 'auto'],
     ['transform', 'none'], ['pointer-events', 'auto'], ['display', 'none'],
    ].forEach(function (p) { host.style.setProperty(p[0], p[1], 'important'); });

    var shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = '<style>' + ADD_CSS + '</style>' +
      '<div class="row">' +
        // The + now means "put something here", which is the question people
        // actually arrive with, and it opens the whole list.
        '<button class="more" title="Insert something here" aria-expanded="false">' +
          '<svg viewBox="0 0 16 16" aria-hidden="true">' +
          '<path d="M7 2h2v5h5v2H9v5H7V9H2V7h5z"/>' +
          '</svg>' +
        '</button>' +
        // Two stacked sheets: one more of the thing already there. A specific
        // action deserves a specific picture, not the most general symbol on
        // the row.
        '<button class="block" title="Add another one of these">' +
          '<svg viewBox="0 0 16 16" aria-hidden="true">' +
          '<path d="M5 2h8a1 1 0 0 1 1 1v8h-2V4H5z"/>' +
          '<path d="M3 5h6a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/>' +
          '</svg>' +
        '</button>' +
        '<button class="note" title="Comment on this section">' +
          '<svg viewBox="0 0 16 16" aria-hidden="true">' +
          '<path d="M3 2h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7l-3.6 2.8V12H3a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/>' +
          '</svg>' +
        '</button>' +
        '<div class="menu" hidden>' +
          '<button class="same" data-same="1"></button>' +
          '<div class="sep"></div>' +
          Structures.KINDS.map(function (k) {
            return '<button data-kind="' + k.id + '">' + k.label + '</button>';
          }).join('') +
        '</div>' +
      '</div>';

    shadow.querySelector('.block').addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (state.hoverBlock) addAfterBlock(state.hoverBlock);
    });

    /*
     * The + opens the list — a paragraph, a table, a heading — all inserted in
     * the same place, which is the point of offering it from here rather than
     * only from the toolbar: the controls are already beside the block, so
     * there is no question of where the new thing goes.
     *
     * The first item in that list is still "another one of these", so the
     * common case is two clicks from here and one click from the button
     * beside it.
     */
    var menu = shadow.querySelector('.menu');
    shadow.querySelector('.more').addEventListener('mousedown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      setAddMenuOpen(menu.hidden);
    });

    menu.addEventListener('mousedown', function (e) {
      var btn = e.target.closest && e.target.closest('button');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      var block = state.hoverBlock;
      setAddMenuOpen(false);
      hideAdd();
      if (!block) return;
      if (btn.hasAttribute('data-same')) addAfterBlock(block);
      else insertStructure(btn.getAttribute('data-kind'), block);
    });
    shadow.querySelector('.note').addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (state.hoverBlock) addCommentTo(state.hoverBlock);
    });

    // The buttons stand off the block now, so the pointer has to cross a sliver
    // of page to reach them; don't take them away while it is in flight.
    host.addEventListener('mouseenter', clearAddHide);
    host.addEventListener('mouseleave', requestHideAdd);

    doc().documentElement.appendChild(host);
    state.add = {
      host: host,
      row: shadow.querySelector('.row'),
      menu: menu,
      plus: shadow.querySelector('.more'),
      same: shadow.querySelector('.same'),
    };
    return state.add;
  }

  /*
   * The insert menu hanging off the hover controls.
   *
   * While it is open the controls must not be taken away, however far the
   * pointer wanders — the user is reading a menu, not leaving.
   */
  function setAddMenuOpen(open) {
    if (!state.add) return;
    state.add.menu.hidden = !open;
    state.add.plus.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      clearAddHide();
      // Name the block being hovered, so the first item says what it will add.
      var tag = state.hoverBlock ? state.hoverBlock.localName : 'block';
      state.add.same.textContent = 'Another ' + tag;
    }
  }

  function isAddMenuOpen() {
    return !!(state.add && !state.add.menu.hidden);
  }

  function clearAddHide() {
    if (state.addHideTimer) {
      clearTimeout(state.addHideTimer);
      state.addHideTimer = 0;
    }
  }

  function hideAdd() {
    setAddMenuOpen(false);
    clearAddHide();
    if (state.add) state.add.host.style.setProperty('display', 'none', 'important');
    state.hoverBlock = null;
  }

  /*
   * Leaving the block is only a hint: the pointer may be on its way to a button.
   *
   * The buttons sit ADD_BTN + ADD_GAP to the left of the text, so reaching them
   * means crossing a strip of ordinary page that belongs to neither. Every
   * mouseover in that strip lands on the document and reads as "gone". Two
   * things keep the buttons where the user is aiming:
   *
   *   - a grace period long enough to cross 30px and land on a 22px target,
   *     which 220ms was not; people who track a small control are slower than
   *     people who already know where it is
   *   - inApproachCorridor(), which does not start the countdown at all while
   *     the pointer is in the strip beside the block it belongs to
   *
   * Together these mean the buttons go away when you leave, and stay when you
   * are on your way to them.
   */
  function requestHideAdd() {
    if (isAddMenuOpen()) return;
    if (!state.add || !state.hoverBlock || state.addHideTimer) return;
    state.addHideTimer = setTimeout(function () {
      state.addHideTimer = 0;
      hideAdd();
    }, 650);
  }

  /*
   * Is the pointer in the dead strip between the hovered block and its buttons?
   *
   * The corridor is the block's own vertical band, widened a little for a
   * diagonal approach, running from just past the buttons to the block's right
   * edge. Inside it, nothing is hiding.
   */
  function inApproachCorridor(e) {
    if (!state.hoverBlock) return false;
    var r = state.hoverBlock.getBoundingClientRect();
    if (!r.width && !r.height) return false;
    var reach = ADD_BTN + ADD_GAP + 10;
    return e.clientY >= r.top - 10 && e.clientY <= r.bottom + 10 &&
           e.clientX >= r.left - reach && e.clientX <= r.right;
  }

  /*
   * Park the buttons in the page's left margin, level with the block's first
   * line, so they never sit on the words. A block hard against the left edge
   * has no margin to use, and there falls back to a pill straddling the top
   * edge — opaque, so it reads over whatever is underneath. Positioned in
   * document coordinates so it stays put while the page scrolls.
   */
  function showAddFor(block) {
    var ui = ensureAddButton();
    var rect = block.getBoundingClientRect();
    if (!rect.width && !rect.height) { hideAdd(); return; }

    clearAddHide();
    state.hoverBlock = block;

    var left = rect.left + win().scrollX;
    var top = rect.top + win().scrollY;
    if (left >= ADD_BTN + ADD_GAP + 4) {
      ui.row.className = 'row stack';
      left -= ADD_BTN + ADD_GAP;
    } else {
      ui.row.className = 'row over';
      if (top >= ADD_BTN + 6) top -= ADD_BTN + 6;
    }

    ui.host.style.setProperty('left', left + 'px', 'important');
    ui.host.style.setProperty('top', top + 'px', 'important');
    ui.host.style.setProperty('display', 'block', 'important');
  }

  // Remember where the caret has been, so Insert still knows after the toolbar
  // has taken focus away. Focus moving into the toolbar is not an island, so it
  // leaves the last one standing, which is exactly what is wanted.
  function onFocusIn(e) {
    var island = islandOf(e.target);
    if (island) state.lastIsland = island;
  }

  function onMouseDownAnywhere() {
    // The bar's and the hover controls' own handlers stopPropagation, so
    // reaching here means the click was somewhere else.
    if (isMenuOpen()) setMenuOpen(false);
    if (isMoreOpen()) setMoreOpen(false);
    if (isAddMenuOpen()) { setAddMenuOpen(false); hideAdd(); }
  }

  function onMouseOver(e) {
    if (!state.active) return;
    if (state.add && e.target === state.add.host) {   // over the buttons themselves
      clearAddHide();
      return;
    }

    var island = islandOf(e.target);
    if (!island) {
      if (inApproachCorridor(e)) { clearAddHide(); return; }
      requestHideAdd();
      return;
    }

    var block = Blocks.blockFor(island);
    if (!block || !canAddAfter(block)) {
      if (inApproachCorridor(e)) { clearAddHide(); return; }
      requestHideAdd();
      return;
    }
    clearAddHide();
    if (block !== state.hoverBlock) showAddFor(block);
  }

  var LISTENERS = [
    ['beforeinput', onBeforeInput, true],
    ['input', onInput, true],
    ['paste', onPaste, true],
    ['drop', onDrop, true],
    ['dragover', onDragOver, true],
    ['keydown', onKeyDown, true],
    ['focusin', onFocusIn, true],
    ['mouseover', onMouseOver, true],
    ['mousedown', onMouseDownAnywhere, false],
    ['click', onClick, true],
    ['submit', onSubmit, true],
  ];

  function addListeners() {
    if (state.listening) return;
    LISTENERS.forEach(function (l) { doc().addEventListener(l[0], l[1], l[2]); });
    win().addEventListener('resize', onResize);
    state.listening = true;
  }

  function removeListeners() {
    if (!state.listening) return;
    LISTENERS.forEach(function (l) { doc().removeEventListener(l[0], l[1], l[2]); });
    win().removeEventListener('resize', onResize);
    state.listening = false;
  }

  // --- comments --------------------------------------------------------------

  var COMMENTED_ATTR = 'data-vr-commented';
  var ACTIVE_ATTR = 'data-vr-comment-active';
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
    // A reply is the same card, stepped in and tied to the one above it, so a
    // thread reads as one object in the margin without needing a container.
    '.card.reply {',
    '  width: 244px; border-left-color: #c9bda0;',
    '  border-top-left-radius: 3px;',
    '}',
    '.card.reply .who::before { content: "\\21b3\\00a0"; color: #a9a08c; font-weight: 400; }',
    '.foot { margin-top: 6px; }',
    '.reply-btn {',
    '  font: 600 11px/1 system-ui, sans-serif; border: 0; background: transparent;',
    '  color: #8a7f66; cursor: pointer; padding: 3px 5px; border-radius: 4px;',
    '}',
    '.reply-btn:hover { background: rgba(0, 0, 0, .07); color: #4a4133; }',
    'textarea {',
    '  font: inherit; width: 100%; border: 0; padding: 0; margin: 0;',
    '  background: transparent; color: inherit; resize: none; overflow: hidden;',
    '  outline: none; display: block;',
    '}',
    'textarea::placeholder { color: #a9a08c; }',
    '@media (prefers-color-scheme: dark) {',
    '  .card { background: #2a2620; color: #ece9e2; border-color: #4a4133; }',
    '  .card.reply { border-left-color: #6b6250; }',
    '  .who { color: #b8ad93; }',
    '  .reply-btn { color: #b8ad93; }',
    '  .reply-btn:hover { background: rgba(255, 255, 255, .12); color: #ece9e2; }',
    '  textarea::placeholder { color: #7d7462; }',
    '}',
  ].join('\n');

  /*
   * The notes to show, in the order they should be read.
   *
   * Document order of the section each one is attached to, and within a
   * section the order they were written. That is what makes a reply a reply:
   * nothing in the file marks one, and nothing needs to — a thread is simply
   * the notes that share a block, oldest first. Writing it this way means a
   * reply survives being read by anything that knows only what an HTML
   * comment is.
   */
  function liveComments() {
    var live = state.comments.filter(function (r) { return !r.removed; });
    var order = new Map();
    for (var i = 0; i < live.length; i++) order.set(live[i], i);

    return live.sort(function (a, b) {
      if (a.block !== b.block && a.block && b.block && a.block.compareDocumentPosition) {
        var rel = a.block.compareDocumentPosition(b.block);
        if (rel & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (rel & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      }
      return order.get(a) - order.get(b);
    });
  }

  // How many live notes sit on this block, and where this one comes in that
  // thread. Index 0 opens it; anything after is a reply.
  function threadIndex(region) {
    var n = 0;
    var live = liveComments();
    for (var i = 0; i < live.length; i++) {
      if (live[i] === region) return n;
      if (live[i].block === region.block) n++;
    }
    return n;
  }

  /*
   * What the file would hold for this note if it were saved right now: its
   * text, or null when the file would not contain it at all. A note that was
   * deleted and a note that was emptied both come to the same thing.
   */
  function commentWanted(r) {
    if (r.removed) return null;
    return r.text.trim() || null;
  }

  // What the file holds for it now: null when it is not in there.
  function commentInFile(r) {
    return r.saved == null ? null : r.saved;
  }

  // Is this note exactly what the file holds, in the form it will be written?
  function commentSettled(r) {
    if (commentWanted(r) !== commentInFile(r)) return false;
    if (commentInFile(r) === null) return true;
    return !!r.savedVisible === !!state.commentsVisible;
  }

  function commentChangedCount() {
    var n = 0;
    for (var i = 0; i < state.comments.length; i++) {
      var r = state.comments[i];
      if (r.removed) { if (r.token) n++; continue; }   // a deleted existing comment is a change
      if (r.text.trim() !== r.original) { n++; continue; }
      // Same words, written the other way round: showing a note in the
      // document, or hiding it again, changes the file.
      if (r.token && !!r.element !== !!state.commentsVisible) n++;
    }
    return n;
  }

  /*
   * Notes that differ from the file as it was last written.
   *
   * Compared against what the file HOLDS rather than against the text the note
   * was last saved with. Those are not the same thing for a note that was
   * deleted: it used to count as unsaved for ever, because its text had been
   * recorded as saved while the fact of its removal never was, so the status
   * bar claimed unsaved work after a save that had plainly succeeded — and
   * the unload warning went on firing on a file with nothing left to lose.
   */
  function commentUnsavedCount() {
    var n = 0;
    for (var i = 0; i < state.comments.length; i++) {
      var r = state.comments[i];
      if (commentWanted(r) !== commentInFile(r)) { n++; continue; }
      if (commentInFile(r) === null) continue;
      if (!!r.savedVisible !== !!state.commentsVisible) n++;
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
    var found = [];
    var paired = state.map.comments.paired;

    for (var i = 0; i < paired.length; i++) {
      var parsed = Comments.parse(paired[i].node.data);
      if (parsed === null) continue;
      var node = paired[i].node;
      found.push({
        token: paired[i].token,
        node: node,
        element: null,
        block: node.nextElementSibling || node.parentElement,
        parsed: parsed,
      });
    }

    /*
     * The visible form. Its range in the file is the whole element, start tag
     * to end tag, which mapping already works out for every element it could
     * pair with the source. One without both tags is left alone: a note we
     * cannot find the edges of is one we cannot safely rewrite or remove.
     */
    var rendered = doc().querySelectorAll('[' + Comments.RENDERED_ATTR + ']');
    for (var j = 0; j < rendered.length; j++) {
      var el = rendered[j];
      var tags = state.map.elements.get(el);
      if (!tags || !tags.startTag || !tags.endTag) continue;
      var fromEl = Comments.parseElement(el);
      if (fromEl === null) continue;
      found.push({
        token: { start: tags.startTag.start, end: tags.endTag.end },
        node: null,
        element: el,
        block: el.nextElementSibling || el.parentElement,
        parsed: fromEl,
      });
    }

    // Source order, so a thread reads in the order it was written whichever
    // form each note happens to be in.
    found.sort(function (a, b) { return a.token.start - b.token.start; });

    for (var k = 0; k < found.length; k++) {
      var f = found[k];
      state.comments.push({
        kind: 'comment',
        token: f.token,
        node: f.node,
        element: f.element,
        block: f.block,
        author: f.parsed.author,
        date: f.parsed.date,
        text: f.parsed.text,
        original: f.parsed.text,
        saved: f.parsed.text,
        savedVisible: !!f.element,
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
      flash('VibeRevise cannot tell where this section starts in the file');
      return null;
    }
    if (!authorName() && !state.nudgedName) {
      state.nudgedName = true;
      flash('Tip: add your name from ⋯ so people can see who wrote this');
    }
    var region = {
      kind: 'comment',
      token: null,
      node: null,
      element: null,
      block: block,
      author: authorName(),
      date: Comments.today(),
      text: '',
      original: '',
      saved: null,            // not in the file at all until it is written
      savedVisible: false,
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

  /*
   * Move the switch. Nothing is written here — the next save is what rewrites
   * the file — but every note that is in it immediately counts as unsaved, so
   * the status bar and the margin say straight away that a save is pending
   * rather than letting a toggle look like it did nothing.
   */
  function setCommentsVisible(next) {
    next = !!next;
    if (next === state.commentsVisible) return;
    state.commentsVisible = next;
    if (state.ui && state.ui.showComments) state.ui.showComments.checked = next;
    if (state.settings) {
      Promise.resolve(state.settings.set('commentsVisible', next)).catch(function () {});
    }
    renderRail();
    refresh();

    var n = state.comments.filter(function (r) {
      return commentInFile(r) !== null;
    }).length;
    flash(next
      ? (n ? 'Comments will be visible in the file — save to rewrite ' + n + ' of them'
           : 'Comments will be saved as visible notes')
      : (n ? 'Comments will be hidden again — save to rewrite ' + n + ' of them'
           : 'Comments will be saved as HTML comments, which no browser shows'));
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

    var html = doc().documentElement;
    state.railStyle = {
      paddingRight: html.style.getPropertyValue('padding-right'),
      paddingPriority: html.style.getPropertyPriority('padding-right'),
      position: html.style.getPropertyValue('position'),
      positionPriority: html.style.getPropertyPriority('position'),
    };
    html.style.setProperty('padding-right', RAIL_WIDTH + 'px', 'important');
    // So the rail positions against the padding box rather than the viewport.
    html.style.setProperty('position', 'relative', 'important');

    var host = doc().createElement('div');
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
      var html = doc().documentElement;
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
    var marked = doc().querySelectorAll('[' + COMMENTED_ATTR + ']');
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
      var isReply = threadIndex(region) > 0;
      var card = doc().createElement('div');
      card.className = 'card' + (commentSettled(region) ? '' : ' unsaved') +
        (isReply ? ' reply' : '');
      card.innerHTML =
        '<div class="head"><span class="who"></span>' +
        '<button class="del" title="Delete this comment">&times;</button></div>' +
        '<textarea rows="1" placeholder="' +
          (isReply ? 'Write a reply…' : 'Write a comment…') + '"></textarea>' +
        '<div class="foot">' +
          '<button class="reply-btn" title="Add a reply to this thread">Reply</button>' +
        '</div>';

      // Whoever the note says wrote it; a new one is the current user's until
      // it is saved.
      var who = region.token ? region.author : (region.author || authorName());
      card.querySelector('.who').textContent = who
        ? who + (region.date ? ' · ' + region.date : '')
        : 'Comment';
      var textarea = card.querySelector('textarea');
      textarea.value = region.text;

      textarea.addEventListener('input', function () {
        region.text = textarea.value;
        autoGrow(textarea);
        card.className = 'card' + (commentSettled(region) ? '' : ' unsaved');
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
      // A reply is another note on the same section. Nothing in the file says
      // so; it is a reply because it sits in the same thread, which is what
      // keeps the format something a text editor can still make sense of.
      card.querySelector('.reply-btn').addEventListener('click', function () {
        addCommentTo(region.block);
      });

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
        wanted = rect.top + win().scrollY;
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
    var el = doc().createElement('style');
    el.setAttribute(UI_ATTR, '');
    el.textContent = ISLAND_CSS;
    (doc().head || doc().documentElement).appendChild(el);
    state.styleEl = el;
  }

  /*
   * The status bar lives in a closed shadow root so the page's stylesheet
   * cannot reach into it and our styles cannot leak out. The host element's own
   * positioning is set inline with !important, since that is the one part a
   * page rule could still fight over.
   */
  // The same speech bubble the hover controls use, so the button in the bar
  // reads as "comments" rather than as "a menu of other things".
  var BUBBLE =
    '<svg viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M3 2h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7l-3.6 2.8V12H3a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/>' +
    '</svg>';

  function ensureStatusBar() {
    if (state.ui && state.ui.host.isConnected) return;

    var host = doc().createElement('div');
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
        '<button class="count" title="Show what has changed"></button>' +
        '<span class="msg"></span>' +
        '<span class="sep"></span>' +
        '<button class="insert" title="Add a table, a list, a heading">Insert \u25be</button>' +
        '<div class="menu" hidden>' +
          Structures.KINDS.map(function (k) {
            return '<button data-kind="' + k.id + '">' + k.label + '</button>';
          }).join('') +
          '<div class="hint">Copied from the nearest one already in the document, ' +
          'so it matches.</div>' +
        '</div>' +
        '<span class="sep"></span>' +
        '<button class="undo icon" title="Undo (Ctrl/Cmd+Z)" aria-label="Undo" disabled>\u21b6</button>' +
        '<button class="redo icon" title="Redo (Ctrl/Cmd+Shift+Z)" aria-label="Redo" disabled>\u21b7</button>' +
        '<span class="sep"></span>' +
        '<button class="more-btn icon" title="Comments and review" ' +
                'aria-label="Comments and review">' + BUBBLE + '</button>' +
        '<div class="panel" hidden>' +
          '<div class="p-head">' +
            '<span class="p-title">Comments &amp; review</span>' +
            '<button class="p-info" aria-expanded="false" ' +
                    'title="What these do" aria-label="What these do">i</button>' +
          '</div>' +
          '<div class="p-row">' +
            '<input id="vr-author" class="p-input" maxlength="60" autocomplete="name" ' +
                   'aria-label="Your name" placeholder="Your name">' +
            '<button class="p-save">Save</button>' +
          '</div>' +
          '<div class="p-hint" data-info hidden>Signs your comments and the list of ' +
            'changes. Not a sign-in — anyone can type any name.</div>' +
          '<label class="p-check">' +
            '<input type="checkbox" class="p-show-comments">' +
            'Show comments in the document' +
          '</label>' +
          '<div class="p-hint" data-info hidden>Off, a comment is hidden in the file: ' +
            'it travels with the document but no browser shows it. On, it is saved as ' +
            'a visible note anyone can read without VibeRevise. The switch goes both ' +
            'ways, and rewrites every comment next time you save.</div>' +
          '<div class="p-sep"></div>' +
          '<button class="p-changes">Show changes</button>' +
        '</div>' +
        '<button class="save primary" disabled>Save</button>' +
        '<button class="done">Done</button>' +
      '</div>';

    doc().documentElement.appendChild(host);

    var ui = {
      host: host,
      count: shadow.querySelector('.count'),
      msg: shadow.querySelector('.msg'),
      insert: shadow.querySelector('.insert'),
      menu: shadow.querySelector('.menu'),
      undo: shadow.querySelector('.undo'),
      redo: shadow.querySelector('.redo'),
      save: shadow.querySelector('.save'),
      done: shadow.querySelector('.done'),
      moreBtn: shadow.querySelector('.more-btn'),
      panel: shadow.querySelector('.panel'),
      authorInput: shadow.querySelector('.p-input'),
      authorSave: shadow.querySelector('.p-save'),
      changesBtn: shadow.querySelector('.p-changes'),
      info: shadow.querySelector('.p-info'),
      infoRows: shadow.querySelectorAll('[data-info]'),
      showComments: shadow.querySelector('.p-show-comments'),
    };
    ui.info.addEventListener('click', function () {
      var open = ui.info.getAttribute('aria-expanded') !== 'true';
      ui.info.setAttribute('aria-expanded', open ? 'true' : 'false');
      for (var i = 0; i < ui.infoRows.length; i++) ui.infoRows[i].hidden = !open;
    });
    ui.showComments.checked = !!state.commentsVisible;
    ui.showComments.addEventListener('change', function () {
      setCommentsVisible(ui.showComments.checked);
    });
    // mousedown, not click: by click time the caret has already left the text
    // the user was editing, and undo would restore it somewhere they cannot see.
    // mousedown with the default prevented, so opening the menu does not pull
    // the caret out of the text. currentBlock() can recover from that, but not
    // losing it in the first place is better: the page does not jump and the
    // user's selection survives.
    ui.insert.addEventListener('mousedown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      setMenuOpen(ui.menu.hidden);
    });
    ui.insert.addEventListener('click', function (e) { e.stopPropagation(); });
    // mousedown, not click: the menu closes on the document's click, and by
    // then this button no longer exists to have been clicked.
    ui.menu.addEventListener('mousedown', function (e) {
      var btn = e.target.closest && e.target.closest('button[data-kind]');
      if (!btn) return;
      e.preventDefault();
      setMenuOpen(false);
      insertStructure(btn.getAttribute('data-kind'));
    });

    ui.undo.addEventListener('mousedown', function (e) { e.preventDefault(); undo(); });
    ui.redo.addEventListener('mousedown', function (e) { e.preventDefault(); redo(); });
    ui.save.addEventListener('click', function () { save(); });
    ui.done.addEventListener('click', function () { setActive(false); });

    ui.count.addEventListener('mousedown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      toggleChanges();
    });
    ui.moreBtn.addEventListener('mousedown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      setMoreOpen(ui.panel.hidden);
    });
    // The panel holds a text field, so it must take focus and keep it: stop
    // the page's mousedown handler from treating a click in here as "away".
    ui.panel.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    ui.authorSave.addEventListener('click', function () {
      setAuthor(ui.authorInput.value);
      flash(state.author ? 'Hello, ' + state.author : 'Name cleared');
      setMoreOpen(false);
    });
    ui.authorInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); ui.authorSave.click(); }
      e.stopPropagation();       // typing a name is not an editing shortcut
    });
    ui.changesBtn.addEventListener('click', function () {
      setMoreOpen(false);
      openChanges();
    });
    state.ui = ui;
  }

  /*
   * The insert menu. Closed by anything that is not it: a click elsewhere, Esc,
   * leaving edit mode, or choosing something from it.
   */
  function setMenuOpen(open) {
    if (!state.ui) return;
    state.ui.menu.hidden = !open;
    state.ui.insert.textContent = 'Insert ' + (open ? '\u25b4' : '\u25be');
  }

  function isMenuOpen() {
    return !!(state.ui && !state.ui.menu.hidden);
  }

  function removeStatusBar() {
    setMenuOpen(false);
    clearAddHide();
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

    // Counted the way the list of changes counts them — per paragraph, not per
    // run of text — so the number on the bar and the number in the list agree.
    var shown = collectChanges().length || changed;
    var text = changed === 0
      ? 'no changes'
      : shown + (shown === 1 ? ' change' : ' changes') + (unsaved ? ' · unsaved' : ' · saved');
    if (empty) text += ' · ' + empty + ' empty' + (empty === 1 ? '' : 's') + ' not saved';

    state.ui.count.textContent = text;
    state.ui.save.disabled = unsaved === 0;
    state.ui.undo.disabled = state.historyAt === 0;
    state.ui.redo.disabled = state.historyAt >= state.history.length;
    // Saving in place and saving a copy are different enough acts that the
    // button should not use one word for both.
    if (state.served && state.served.canPut) {
      state.ui.save.textContent = 'Save to server';
      state.ui.save.title = 'Write this file back to ' + state.served.url;
    } else {
      state.ui.save.textContent = 'Save';
      state.ui.save.title = '';
    }
    renderChanges();       // only does anything while the list is open
  }

  function flash(message) {
    if (!state.ui) return;
    state.ui.msg.textContent = message;
    clearTimeout(state.flashTimer);
    state.flashTimer = setTimeout(function () {
      if (state.ui) state.ui.msg.textContent = '';
    }, 3000);
  }

  // --- who you are, what changed, and AI rewrites ---------------------------

  /*
   * The user's name, as they typed it. Self-declared: it records who says they
   * wrote something, which is what a team that trusts each other needs, and it
   * is presented as exactly that everywhere it appears.
   */
  function authorName() { return state.author || ''; }
  function displayName(name) { return name || 'You'; }

  function setAuthor(name) {
    state.author = Comments.cleanName(name);
    if (state.settings) {
      Promise.resolve(state.settings.set('author', state.author)).catch(function () {});
    }
    renderMore();
    renderRail();
    renderChanges();
    return state.author;
  }

  function setMoreOpen(open) {
    if (!state.ui) return;
    state.ui.panel.hidden = !open;
    if (open) {
      setMenuOpen(false);
      renderMore();
      state.ui.authorInput.value = authorName();
    }
  }

  function isMoreOpen() { return !!(state.ui && !state.ui.panel.hidden); }

  function renderMore() {
    if (!state.ui) return;
    var n = collectChanges().length;
    state.ui.changesBtn.textContent = n
      ? 'Show changes (' + n + ')' : 'Show changes (none yet)';
  }

  // --- the list of changes ----------------------------------------------------

  var TAG_NAMES = {
    p: 'paragraph', li: 'list item', blockquote: 'quote', td: 'cell', th: 'heading cell',
    h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
  };

  function describeTag(tag) { return TAG_NAMES[tag] || tag; }

  /*
   * Everything that differs from the file as it was opened, in document order,
   * with who did it and whether AI suggested it. Session-level: this is what
   * Save would write, described, not a history kept in the file.
   */
  function collectChanges() {
    var list = [];
    var i, r;

    // Edits are grouped by block. A paragraph with bold in it is several runs
    // of text, and one rewrite of it is one change to one paragraph — not one
    // row per fragment, which reads as several unrelated edits.
    var byBlock = new Map();
    for (i = 0; i < state.regions.length; i++) {
      r = state.regions[i];
      if (r.kind === 'text' && r.current !== r.original) {
        var block = Blocks.blockFor(r.island) || r.island;
        var group = byBlock.get(block);
        if (!group) {
          group = { kind: 'edit', block: block, by: r.by, target: block };
          byBlock.set(block, group);
          list.push(group);
        }
        if (r.by) group.by = r.by;
      } else if (r.kind === 'insert' && !r.removed && r.current) {
        list.push({ kind: 'added', what: describeTag(r.template.tag), after: r.current,
                    by: r.by, target: r.element });
      }
    }
    // Each group's before and after is the whole block's text, unchanged runs
    // included, so the diff shows the edit in the sentence it belongs to.
    byBlock.forEach(function (group, block) {
      var runs = [];
      var islands = block.querySelectorAll ? block.querySelectorAll('[' + Islands.ATTR + ']') : [];
      for (var k = 0; k < islands.length; k++) {
        var reg = regionOf(islands[k]);
        if (reg && reg.kind === 'text') runs.push(reg);
      }
      if (!runs.length) runs = state.regions.filter(function (x) { return x.island === block; });
      group.before = runs.map(function (x) { return x.original; }).join('');
      group.after = runs.map(function (x) { return x.current; }).join('');
    });

    for (i = 0; i < state.trees.length; i++) {
      var t = state.trees[i];
      if (t.removed || !treeHasText(t)) continue;
      var typed = t.cells.filter(function (c) { return c.current; });
      list.push({ kind: 'added', what: Structures.kindById(t.id).label.toLowerCase(),
                  after: typed.map(function (c) { return c.current; }).join(' · '),
                  by: typed[0] && typed[0].by,
                  target: t.element });
    }
    for (i = 0; i < state.comments.length; i++) {
      var c = state.comments[i];
      var text = c.text.trim();
      var target = c.block;
      if (c.removed) {
        if (c.token) list.push({ kind: 'comment-del', before: c.original, by: c.author, target: target });
      } else if (!c.token && text) {
        list.push({ kind: 'comment-add', after: text, by: c.author || authorName(), target: target });
      } else if (c.token && text !== c.original) {
        list.push({ kind: 'comment-edit', before: c.original, after: text, by: c.author, target: target });
      }
    }

    list.sort(function (a, b) {
      if (!a.target || !b.target || a.target === b.target) return 0;
      return a.target.compareDocumentPosition(b.target) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
    return list;
  }

  function changeHeading(ch) {
    var who = displayName(ch.by);
    if (ch.kind === 'edit') {
      return who + ' · edited';
    }
    if (ch.kind === 'added') return who + ' · added a ' + ch.what;
    if (ch.kind === 'comment-add') return who + ' · added a comment';
    if (ch.kind === 'comment-edit') return 'Comment edited' + (ch.by ? ' (' + ch.by + '’s)' : '');
    return 'Comment deleted' + (ch.by ? ' (' + ch.by + '’s)' : '');
  }

  // For display only: a <br> in an island's value reads as a return arrow.
  function visible(value) { return String(value || '').split(Islands.BR).join(' ↵ '); }

  /*
   * Which words changed, as [{ op: 'same'|'del'|'add', text }].
   *
   * Longest common subsequence over words, the ordinary way. This lived in the
   * AI module until that was removed, which was always the wrong home for it:
   * there is nothing AI about asking which words differ, and the list of
   * changes needs the answer whether anything else is installed or not.
   *
   * Splitting on (\s+) keeps the whitespace as its own token, so the pieces
   * rejoin into exactly the text that went in.
   *
   * The table is n*m, so a pathological pair of long runs would allocate more
   * than the answer is worth. Past that bound it says "all of this became all
   * of that" rather than spending a second on a prettier answer nobody is
   * waiting for.
   */
  function diffWords(a, b) {
    var x = String(a).split(/(\s+)/).filter(function (t) { return t !== ''; });
    var y = String(b).split(/(\s+)/).filter(function (t) { return t !== ''; });
    if (x.length * y.length > 4000000) {
      return [{ op: 'del', text: String(a) }, { op: 'add', text: String(b) }];
    }

    var n = x.length, m = y.length;
    var table = [];
    for (var i = 0; i <= n; i++) table.push(new Uint32Array(m + 1));
    for (i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        table[i][j] = x[i] === y[j] ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }

    var out = [];
    function push(op, text) {
      var last = out[out.length - 1];
      if (last && last.op === op) last.text += text;
      else out.push({ op: op, text: text });
    }

    i = 0; j = 0;
    while (i < n && j < m) {
      if (x[i] === y[j]) { push('same', x[i]); i++; j++; }
      else if (table[i + 1][j] >= table[i][j + 1]) { push('del', x[i]); i++; }
      else { push('add', y[j]); j++; }
    }
    while (i < n) push('del', x[i++]);
    while (j < m) push('add', y[j++]);
    return out;
  }

  // Before/after as marked-up words, built from DOM nodes so the document's
  // own text cannot inject anything.
  function diffInto(box, before, after) {
    diffWords(visible(before), visible(after)).forEach(function (part) {
      var node = doc().createElement(part.op === 'same' ? 'span' : part.op === 'del' ? 'del' : 'ins');
      node.textContent = part.text;
      box.appendChild(node);
    });
  }

  function openChanges() {
    ensureAssist().changes.hidden = false;
    renderChanges();
  }
  function closeChanges() { if (state.assist) state.assist.changes.hidden = true; }
  function toggleChanges() {
    if (state.assist && !state.assist.changes.hidden) closeChanges();
    else openChanges();
  }
  function isChangesOpen() { return !!(state.assist && !state.assist.changes.hidden); }

  function renderChanges() {
    if (!state.assist || state.assist.changes.hidden) return;
    var box = state.assist.changes;
    var list = collectChanges();
    box.textContent = '';

    var head = doc().createElement('div');
    head.className = 'c-head';
    var title = doc().createElement('strong');
    title.textContent = list.length ? 'Changes (' + list.length + ')' : 'No changes yet';
    var close = doc().createElement('button');
    close.className = 'x';
    close.title = 'Close';
    close.textContent = '×';
    close.addEventListener('click', closeChanges);
    head.appendChild(title);
    head.appendChild(close);
    box.appendChild(head);

    var note = doc().createElement('div');
    note.className = 'c-note';
    note.textContent = 'What Save would write.';
    box.appendChild(note);

    var ol = doc().createElement('ol');
    ol.className = 'c-list';
    list.forEach(function (ch) {
      var li = doc().createElement('li');
      var btn = doc().createElement('button');
      btn.className = 'c-row';
      var who = doc().createElement('span');
      who.className = 'c-who';
      who.textContent = changeHeading(ch);
      var what = doc().createElement('span');
      what.className = 'c-diff';
      if (ch.kind === 'edit' || ch.kind === 'comment-edit') diffInto(what, ch.before, ch.after);
      else if (ch.kind === 'comment-del') { var d = doc().createElement('del'); d.textContent = visible(ch.before); what.appendChild(d); }
      else what.textContent = visible(ch.after);
      btn.appendChild(who);
      btn.appendChild(what);
      btn.addEventListener('click', function () {
        if (!ch.target || !ch.target.isConnected) return;
        ch.target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        ch.target.setAttribute(ACTIVE_ATTR, '');
        setTimeout(function () { ch.target.removeAttribute(ACTIVE_ATTR); }, 1400);
      });
      li.appendChild(btn);
      ol.appendChild(li);
    });
    box.appendChild(ol);
  }

  // --- the layer the changes list floats in ----------------------------------

  var ASSIST_CSS = [
    ':host { all: initial; }',
    '.layer { position: fixed; inset: 0; pointer-events: none;',
    '  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #f1f2f5; }',
    '[hidden] { display: none !important; }',
    'button { font: inherit; color: inherit; cursor: pointer; border: 0; }',
    '.changes {',
    '  position: absolute; pointer-events: auto; box-sizing: border-box;',
    '  border-radius: 12px; background: rgba(22, 22, 27, .97);',
    '  box-shadow: 0 6px 28px rgba(0, 0, 0, .45);',
    '  right: 16px; bottom: 70px; width: 380px; max-width: calc(100vw - 32px);',
    '  max-height: 62vh; overflow: auto; padding: 12px;',
    '  display: flex; flex-direction: column; gap: 8px;',
    '}',
    '.c-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }',
    '.a-title { font-weight: 600; }',
    '.x { background: transparent; font-size: 17px; line-height: 1; padding: 2px 6px;',
    '  border-radius: 6px; color: #9aa0ad; }',
    '.x:hover { background: rgba(255, 255, 255, .12); color: #fff; }',
    '.c-note { color: #9aa0ad; font-size: 11.5px; }',
    '.c-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }',
    '.c-row { width: 100%; text-align: left; display: flex; flex-direction: column; gap: 3px;',
    '  padding: 8px 10px; border-radius: 8px; background: rgba(255, 255, 255, .06);',
    '  border-left: 3px solid rgba(255, 255, 255, .25); }',
    '.c-row:hover { background: rgba(255, 255, 255, .12); }',
    '.c-who { font-weight: 600; font-size: 12px; }',
    '.c-diff { color: #d6d9e0; font-size: 12px; overflow-wrap: anywhere; }',
    'del { color: #ff9f9f; text-decoration: line-through; text-decoration-color: rgba(255,159,159,.7); }',
    'del + ins, ins + del { margin-left: .3em; }',
    'ins { color: #9fe0b5; text-decoration: none; background: rgba(159, 224, 181, .12); border-radius: 3px; }',
  ].join('\n');

  function ensureAssist() {
    if (state.assist && state.assist.host.isConnected) return state.assist;

    var host = doc().createElement('div');
    host.setAttribute(UI_ATTR, '');
    [['position', 'fixed'], ['left', '0'], ['top', '0'], ['width', '100%'], ['height', '100%'],
     ['z-index', '2147483646'], ['margin', '0'], ['padding', '0'], ['border', '0'],
     ['pointer-events', 'none'], ['display', 'block'], ['transform', 'none'],
     ['opacity', '1'], ['visibility', 'visible'],
    ].forEach(function (p) { host.style.setProperty(p[0], p[1], 'important'); });

    var shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = '<style>' + ASSIST_CSS + '</style>' +
      '<div class="layer">' +
        '<div class="changes" hidden role="dialog" aria-label="Changes"></div>' +
      '</div>';
    doc().documentElement.appendChild(host);

    // A click inside the list is not a click "away" from it.
    shadow.querySelector('.changes').addEventListener('mousedown', function (e) { e.stopPropagation(); });

    state.assist = { host: host, changes: shadow.querySelector('.changes') };
    return state.assist;
  }

  function removeAssist() {
    if (state.assist && state.assist.host.parentNode) {
      state.assist.host.parentNode.removeChild(state.assist.host);
    }
    state.assist = null;
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
    var islands = doc().querySelectorAll('[' + Islands.ATTR + ']');

    for (var i = 0; i < islands.length; i++) {
      var region = state.byIsland.get(islands[i]);
      if (!region || region.removed) continue;

      // A cell does not emit on its own: its tree emits all of them together,
      // below, so a half-filled table still writes every cell it needs.
      if (region.kind === 'cell') continue;

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

    collectStructureEdits(edits);
    collectCommentEdits(edits);
    return edits;
  }

  /*
   * An inserted structure is a single zero-length splice: its whole tree,
   * rendered from the cells the user typed into. One nobody typed anything into
   * is not written at all, on the same grounds as an added block left empty.
   */
  function collectStructureEdits(edits) {
    var newline = Blocks.newlineOf(state.source);

    function textFor(island) {
      var cell = state.byIsland.get(island);
      return cell ? serialise(cell.current, cell.span) : '';
    }

    for (var i = 0; i < state.trees.length; i++) {
      var tree = state.trees[i];
      if (tree.removed || !treeHasText(tree)) continue;

      edits.push({
        start: tree.anchor.offset,
        end: tree.anchor.offset,
        replacement: tree.anchor.before + Structures.markup(tree.element, {
          newline: newline,
          indent: tree.indent,
          text: textFor,
        }) + tree.anchor.after,
      });
    }
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
  // Whichever form the switch currently says, for every note being written.
  function commentMarkup(text, indent, newline, meta) {
    return state.commentsVisible
      ? Comments.renderedMarkup(text, indent, newline, meta)
      : Comments.markup(text, indent, newline, meta);
  }

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
        // Untouched text is still a rewrite when the switch has moved: that is
        // exactly what turning notes on and off means, and it is the one case
        // where a save changes a line nobody typed in.
        var wasVisible = !!region.element;
        if (text === region.original && wasVisible === !!state.commentsVisible) continue;
        // An edited note keeps the attribution it came with: it is still that
        // person's comment, and re-signing it would claim otherwise.
        edits.push({
          start: region.token.start,
          end: region.token.end,
          replacement: commentMarkup(
            text, Blocks.indentOf(state.source, region.token.start), newline,
            { author: region.author, date: region.date }),
        });
        continue;
      }

      edits.push({
        start: region.anchor.offset,
        end: region.anchor.offset,
        // Attributed only once the user has given a name. Someone who never
        // touches the feature gets exactly the plain comment they always did,
        // rather than a date stamped on every note they write.
        replacement: commentMarkup(text, region.anchor.indent, newline,
          (region.author || authorName())
            ? { author: region.author || authorName(), date: region.date || Comments.today() }
            : null) +
          region.anchor.after,
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

    return send({ type: 'vibeRevise:download', url: blobUrl, filename: state.filename })
      .then(function (res) {
        setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 60000);
        if (res && res.ok) { console.log('[VibeRevise] saved via blob URL'); return res; }
        console.warn('[VibeRevise] blob URL download failed, trying a data URL:', res && res.message);
        return send({ type: 'vibeRevise:download', url: toDataUrl(text), filename: state.filename });
      })
      .then(function (res) {
        if (res && res.ok) { console.log('[VibeRevise] saved via data URL'); return res; }
        console.warn('[VibeRevise] downloads API unavailable, falling back to a download link:',
                     res && res.message);
        var a = doc().createElement('a');
        a.setAttribute(UI_ATTR, '');
        a.href = URL.createObjectURL(new Blob([text], { type: 'text/html;charset=utf-8' }));
        a.download = state.filename;
        a.style.setProperty('display', 'none', 'important');
        doc().documentElement.appendChild(a);
        a.click();
        setTimeout(function () {
          URL.revokeObjectURL(a.href);
          if (a.parentNode) a.parentNode.removeChild(a);
        }, 60000);
        return { ok: true, viaAnchor: true };
      });
  }

  /*
   * Write the document back to the server it came from.
   *
   * Only ever reached for an http(s) document whose server answered OPTIONS
   * with PUT in its Allow header, so this is not a probe — it is the save.
   *
   * The write is CONDITIONAL. If the server gave us an ETag or a Last-Modified
   * when we read the document, it comes back as If-Match / If-Unmodified-Since,
   * and a server that honours it returns 412 rather than letting this save
   * overwrite a change made by someone else in the meantime. That is the one
   * thing a save-in-place can get catastrophically wrong, and it costs a header
   * to prevent.
   *
   * Anything other than success falls back to the download path rather than
   * losing the user's edits: a 405 means the route was removed since the probe,
   * a 5xx or a dropped connection means the server is unwell, and in every case
   * the user still gets their file.
   */
  function saveToServer(text) {
    var headers = { 'Content-Type': 'text/html; charset=utf-8' };
    if (state.served.etag) headers['If-Match'] = state.served.etag;
    else if (state.served.lastModified) headers['If-Unmodified-Since'] = state.served.lastModified;

    return fetch(state.served.url, {
      method: 'PUT',
      headers: headers,
      body: text,
      credentials: 'same-origin',
    }).then(function (r) {
      if (r.status === 412) {
        return {
          ok: false,
          conflict: true,
          message: 'the file changed on the server since you opened it. ' +
                   'Reload the page and make your edits again.',
        };
      }
      // The route is not there. Either the Allow header was optimistic or it has
      // been removed since the probe; either way this server does not do
      // save-in-place, so stop offering it for the rest of the session rather
      // than failing the same way on every save.
      if (r.status === 404 || r.status === 405 || r.status === 501) {
        state.served.canPut = false;
        return { ok: false, unsupported: true, message: 'HTTP ' + r.status };
      }
      if (!r.ok) return { ok: false, message: 'HTTP ' + r.status + ' ' + r.statusText };

      // Take the new validator so a second save in the same session is still
      // conditional, and still refuses to clobber.
      var etag = r.headers.get('ETag');
      if (etag) state.served.etag = etag;
      var lm = r.headers.get('Last-Modified');
      if (lm) state.served.lastModified = lm;
      return { ok: true, toServer: true };
    }).catch(function (err) {
      return { ok: false, message: String(err && err.message || err) };
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

  /*
   * Saving through the host — the web app's file handle, or the extension's.
   *
   * A host that turns out not to be able to write says so with fallback:true,
   * and the download catches the edits. Cancelling a dialog is deliberately
   * not that: downloading a file somebody just declined to save would be the
   * opposite of what they asked for.
   */
  function hostSave(text) {
    return Promise.resolve(state.saveFile(text)).then(function (res) {
      if (!res || res.ok || !res.fallback) return res;
      return requestDownload(text).then(function (dl) {
        if (!dl || !dl.ok) return dl;
        return { ok: true, where: 'Could not write to the file — downloaded ' + state.filename + ' instead' };
      });
    });
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
      .concat(state.comments.map(function (r) {
        // null where the file will not hold this note at all, so a deletion is
        // recorded as having been saved rather than only its text.
        return { region: r, value: commentWanted(r), visible: !!state.commentsVisible };
      }));
    var skipped = emptyAddedCount() + emptyCommentCount();

    var toServer = !!(state.served && state.served.canPut);
    flash(state.saveFile ? 'Saving…' : (toServer ? 'Saving to the server…' : 'Saving…'));

    var attempt = state.saveFile ? hostSave(text) : toServer
      ? saveToServer(text).then(function (res) {
          if (res.ok || res.conflict) return res;
          // The server said no. Do not lose the edits over it — fall back to
          // the download. A missing route is an ordinary fact about the server,
          // not a failure worth alarming anyone about; anything else is worth
          // repeating back.
          return requestDownload(text).then(function (dl) {
            if (dl && dl.ok) {
              if (res.unsupported) dl.noRoute = true;
              else dl.fellBack = res.message;
            }
            return dl;
          });
        })
      : requestDownload(text);

    return attempt.then(function (res) {
      if (!res || !res.ok) {
        flash(res && res.conflict
          ? 'Not saved — ' + res.message
          : 'Save failed: ' + ((res && res.message) || 'unknown error'));
        return;
      }
      for (var i = 0; i < snapshot.length; i++) {
        snapshot[i].region.saved = snapshot[i].value;
        if (snapshot[i].region.kind === 'comment') {
          snapshot[i].region.savedVisible = snapshot[i].visible;
        }
      }
      renderRail();
      refresh();

      var where;
      if (res.where) {
        where = res.where;
      } else if (res.toServer) {
        where = 'Saved ' + state.filename + ' to the server';
      } else if (res.noRoute) {
        where = 'This server does not accept saves — downloaded ' + state.filename + ' instead';
      } else if (res.fellBack) {
        where = 'Server refused the save (' + res.fellBack + ') — downloaded instead';
      } else if (res.viaAnchor) {
        where = 'Saved to your Downloads folder as ' + state.filename;
      } else {
        where = 'Saved ' + state.filename + ' — the original file is unchanged';
      }
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
      doc().documentElement.setAttribute(MODE_ATTR, 'on');
      addListeners();
      ensureStatusBar();
      renderRail();
      refresh();
      if (!state.regions.length) flash('No editable text found in this file');
    } else {
      state.active = false;
      doc().documentElement.removeAttribute(MODE_ATTR);
      removeListeners();
      teardownRegions();
      clearHighlights();
      closeRail();
      removeAssist();
      removeStatusBar();
      // The stylesheet stays: any wrappers left holding unsaved edits still need
      // `all: unset` to remain invisible.
    }

    send({ type: 'vibeRevise:state', active: state.active, unsaved: unsavedCount() });
    return state.active;
  }

  function init(options) {
    state.doc = options.doc || null;
    state.settings = options.settings || null;
    state.author = options.author || '';
    if (state.settings) {
      Promise.resolve(state.settings.get('author')).then(function (name) {
        state.author = Comments.cleanName(name || '');
        renderMore();
        renderRail();
      }).catch(function () { /* no stored name is fine */ });
      Promise.resolve(state.settings.get('commentsVisible')).then(function (on) {
        state.commentsVisible = !!on;
        if (state.ui && state.ui.showComments) state.ui.showComments.checked = !!on;
        refresh();
      }).catch(function () { /* the default is off */ });
    }
    // A host that owns saving supplies this: text -> Promise<{ok, where}>. The
    // web app writes through a file handle, shares, or downloads, and knows
    // which of those it did; the extension supplies nothing and keeps the
    // server/download path below.
    state.saveFile = options.saveFile || null;
    // Only the test suite passes this. See fromUser().
    state.trustSynthetic = options.trustSynthetic === true;
    state.win = state.doc ? state.doc.defaultView : null;
    state.source = options.source;
    state.map = options.map;
    state.filename = options.filename || 'page.html';
    // null for a file:// document; for a served one, where to PUT it back and
    // the validators that make the write conditional. See saveToServer().
    state.served = options.served || null;
    // Registered once and left in place: unsaved edits still exist after edit
    // mode is switched off, and losing them to a stray navigation would be the
    // worst thing this extension could do.
    win().addEventListener('beforeunload', onBeforeUnload);
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
      writeBack: state.served && state.served.canPut ? 'server' : 'download',
      author: authorName(),
      changeCount: collectChanges().length,
    };
  }

  root.VibeReviseEditor = {
    init: init,
    // Exposed for the test suite: `preview` is the file that would be written,
    // and `serialise` decides what text lands in it. Both are worth testing
    // directly rather than through a download.
    preview: preview,
    serialise: serialise,
    addAfterIsland: addAfterIsland,
    insertStructure: insertStructure,
    // Authorship and the list of changes.
    setAuthor: setAuthor,
    changes: collectChanges,
    openChanges: openChanges,
    atEndOfBlock: atEndOfBlock,
    addCommentTo: addCommentTo,
    removeComment: removeComment,
    commentRegions: liveComments,
    setActive: setActive,
    // Exposed for the suite: the list of changes is built from this.
    diffWords: diffWords,
    setCommentsVisible: setCommentsVisible,
    commentsVisible: function () { return state.commentsVisible; },
    isActive: function () { return state.active; },
    status: status,
    save: save,
    undo: undo,
    redo: redo,
  };
})(typeof self !== 'undefined' ? self : globalThis);
