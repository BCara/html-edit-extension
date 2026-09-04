/*
 * Quick Edit — end-to-end editor tests.
 *
 * Drives real edit mode over this page's own source, through the same event
 * handlers a keypress goes through. Typing is simulated by dispatching the
 * beforeinput event, performing the mutation the browser would have performed,
 * then dispatching input — the exact contract editor.js is written against.
 * Enter, paste and formatting are not simulated at all: those code paths cancel
 * the browser's default and do the work themselves, so dispatching the event is
 * the whole story.
 *
 * The file that would be saved is checked with QuickEditEditor.preview(), which
 * returns the spliced bytes without starting a download.
 */
'use strict';

Report.mount('out', 'summary');
const { line, heading, ok, eq } = Report;

const BR = QuickEditIslands.BR;
let SOURCE = '';

// --- simulation helpers -----------------------------------------------------

function islandFor(selector, which) {
  const host = document.querySelector(selector);
  const islands = host.querySelectorAll('[data-qe-island]');
  return islands[which || 0];
}

function valueOf(island) { return QuickEditIslands.readValue(island); }

function caretTo(island, index) {
  island.focus();
  QuickEditIslands.setCaret(island, index == null ? valueOf(island).length : index);
}

// Typing: the browser fires beforeinput, mutates, then fires input.
function typeInto(island, text, index) {
  caretTo(island, index);
  const before = new InputEvent('beforeinput', {
    inputType: 'insertText', data: text, bubbles: true, cancelable: true,
  });
  island.dispatchEvent(before);
  if (before.defaultPrevented) return false;

  const sel = document.getSelection();
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);

  island.dispatchEvent(new InputEvent('input', {
    inputType: 'insertText', data: text, bubbles: true,
  }));
  return true;
}

// Deleting backwards over `count` characters, same three-step contract.
function backspace(island, count, index) {
  caretTo(island, index);
  const before = new InputEvent('beforeinput', {
    inputType: 'deleteContentBackward', bubbles: true, cancelable: true,
  });
  island.dispatchEvent(before);
  if (before.defaultPrevented) return false;

  const sel = document.getSelection();
  const range = sel.getRangeAt(0);
  for (let i = 0; i < count; i++) range.setStart(range.startContainer, range.startOffset - 1);
  range.deleteContents();
  sel.removeAllRanges();
  sel.addRange(range);

  island.dispatchEvent(new InputEvent('input', {
    inputType: 'deleteContentBackward', bubbles: true,
  }));
  return true;
}

function dispatchBeforeInput(island, inputType, index) {
  caretTo(island, index);
  const ev = new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true });
  island.dispatchEvent(ev);
  return ev;
}

function pasteInto(island, plain, html, index) {
  caretTo(island, index);
  const dt = new DataTransfer();
  dt.setData('text/plain', plain);
  if (html) dt.setData('text/html', html);
  const ev = new ClipboardEvent('paste', {
    clipboardData: dt, bubbles: true, cancelable: true,
  });
  island.dispatchEvent(ev);
  return ev;
}

// The bytes outside [start, end) must be the original bytes, unchanged.
function onlyChangedInside(edited, span, name) {
  const headOk = edited.slice(0, span.start) === SOURCE.slice(0, span.start);
  const tailLen = SOURCE.length - span.end;
  const tailOk = edited.slice(edited.length - tailLen) === SOURCE.slice(span.end);
  ok(headOk && tailOk, name,
     (headOk ? '' : 'bytes before the edit changed; ') + (tailOk ? '' : 'bytes after the edit changed'));
}

// --- the suite --------------------------------------------------------------

async function run() {
  SOURCE = await fetch(location.href).then((r) => r.text());
  const map = QuickEditMap.build(SOURCE, document);

  heading('setup');
  ok(map.stats.editable > 0, 'the page maps to editable regions (' + map.stats.editable + ')');
  const harnessText = map.records.filter(
    (r) => r.editable && r.node.data.indexOf('Running') !== -1);
  eq(harnessText.length, 0, 'the harness UI is excluded from the map');

  QuickEditEditor.init({ source: SOURCE, map, filename: 'editor-test.html' });
  QuickEditEditor.setActive(true);
  ok(QuickEditEditor.isActive(), 'edit mode turns on');

  const islands = document.querySelectorAll('[data-qe-island]');
  eq(islands.length, map.stats.editable, 'one island per editable region');
  ok(Array.prototype.every.call(islands, (el) => el.getAttribute('contenteditable') === 'true'),
     'every island is editable');

  heading('no edits');
  eq(QuickEditEditor.preview(), SOURCE, 'with nothing changed, the file is byte-identical');
  eq(QuickEditEditor.status().changed, 0, 'and nothing is reported as changed');

  heading('typing');
  {
    const island = islandFor('#p3');
    const span = map.records.find((r) => r.node === island.firstChild).span;
    ok(typeInto(island, ' Typed.'), 'a keystroke is not blocked');
    eq(valueOf(island), 'A plain paragraph to type into. Typed.', 'the island holds the new text');

    const edited = QuickEditEditor.preview();
    ok(edited.indexOf('A plain paragraph to type into. Typed.') !== -1,
       'the typed text reaches the file');
    onlyChangedInside(edited, span, 'every byte outside the edited region is untouched');
    eq(QuickEditEditor.status().changed, 1, 'one region is reported as changed');
  }

  heading('characters that need escaping');
  {
    const island = islandFor('#p4');
    typeInto(island, ' 5 < 6 & 7 > 2');
    const edited = QuickEditEditor.preview();
    ok(edited.indexOf('5 &lt; 6 &amp; 7 &gt; 2') !== -1,
       'typed angle brackets and ampersands are encoded');
    ok(edited.indexOf('5 < 6 & 7 > 2') === -1, 'and never written raw');

    // The document still parses to the text the user typed, with no new tags.
    const after = new DOMParser().parseFromString(edited, 'text/html');
    ok(after.querySelector('#p4').textContent.indexOf('5 < 6 & 7 > 2') !== -1,
       'and read back as exactly what was typed');
    eq(after.querySelectorAll('#p4 *').length,
       document.querySelectorAll('#p4 [data-qe-island]').length > 0
         ? new DOMParser().parseFromString(SOURCE, 'text/html').querySelectorAll('#p4 *').length
         : -1,
       'no new elements appeared in that paragraph');
  }

  heading('Enter inserts a <br>');
  {
    const island = islandFor('#p1');   // the "Hello " run, beside <strong>
    const before = valueOf(island);
    const ev = dispatchBeforeInput(island, 'insertParagraph', before.length);
    ok(ev.defaultPrevented, 'the browser default is cancelled');
    eq(valueOf(island), before + BR, 'a line break is recorded in the island value');

    const edited = QuickEditEditor.preview();
    ok(edited.indexOf('<p id="p1">Hello <br><strong>bold <em>and italic</em></strong> world</p>') !== -1,
       'the <br> lands in the file and the tags beside it do not move');

    const parsedBefore = new DOMParser().parseFromString(SOURCE, 'text/html');
    const parsedAfter = new DOMParser().parseFromString(edited, 'text/html');
    eq(parsedAfter.querySelectorAll('br').length,
       parsedBefore.querySelectorAll('br').length + 1,
       'exactly one <br> was added to the document');
  }

  heading('anything but plain text editing is refused');
  {
    const island = islandFor('#p3');
    const before = valueOf(island);

    for (const type of ['formatBold', 'formatItalic', 'formatIndent',
                        'insertFromDrop', 'insertOrderedList', 'insertHorizontalRule',
                        'insertLink', 'insertFromPaste']) {
      const ev = dispatchBeforeInput(island, type);
      ok(ev.defaultPrevented, type + ' is cancelled');
    }

    // Chrome blanks an inputType its own constructor does not recognise, which
    // is exactly the "unknown command" case the whitelist exists for.
    const unknown = dispatchBeforeInput(island, 'somethingNobodyHasInventedYet');
    eq(unknown.inputType, '', 'the browser hands back an empty input type');
    ok(unknown.defaultPrevented, 'and an unrecognised input type is refused, not waved through');

    eq(valueOf(island), before, 'none of the refused commands changed the text');
    ok(QuickEditIslands.isClean(island), 'the island still contains only text and <br>');
  }

  heading('paste is stripped to plain text');
  {
    const island = islandFor('#p3');
    const before = valueOf(island);
    const ev = pasteInto(island, 'pasted words', '<b>pasted</b> <i>words</i>', before.length);
    ok(ev.defaultPrevented, 'the browser default paste is cancelled');
    eq(valueOf(island), before + 'pasted words', 'only the plain text is inserted');
    ok(QuickEditIslands.isClean(island), 'no elements came in with it');
    ok(QuickEditEditor.preview().indexOf('<b>pasted</b>') === -1,
       'the pasted markup never reaches the file');
  }

  heading('paste with line breaks');
  {
    const island = islandFor('#p3');
    const before = valueOf(island);
    pasteInto(island, 'line one\nline two', null, before.length);
    eq(valueOf(island), before + 'line one' + BR + 'line two',
       'newlines in pasted text become line breaks');
    ok(QuickEditEditor.preview().indexOf('line one<br>line two') !== -1,
       'and are written as <br>');
  }

  heading('undo and redo');
  {
    const island = islandFor('#p2');   // the entity-bearing paragraph
    const original = valueOf(island);
    typeInto(island, '!!');
    const typed = valueOf(island);
    ok(typed !== original, 'the edit happened');

    QuickEditEditor.undo();
    eq(valueOf(island), original, 'undo restores the previous text');
    ok(QuickEditEditor.preview().indexOf('Smith&nbsp;&amp;&nbsp;Sons, 5 &lt; 6, &#39;quoted&#39;') !== -1,
       'and the entities are back to the original bytes');

    QuickEditEditor.redo();
    eq(valueOf(island), typed, 'redo puts the edit back');

    QuickEditEditor.undo();
    eq(valueOf(island), original, 'and undo takes it away again');
  }

  heading('undo across regions');
  {
    const a = islandFor('#p3');
    const b = islandFor('#p4');
    const aBefore = valueOf(a);
    const bBefore = valueOf(b);

    typeInto(a, ' A');
    typeInto(b, ' B');
    QuickEditEditor.undo();
    eq(valueOf(b), bBefore, 'undo steps back into the most recent region');
    eq(valueOf(a), aBefore + ' A', 'and leaves the earlier one alone');
    QuickEditEditor.undo();
    eq(valueOf(a), aBefore, 'the next undo steps back into the earlier region');
    QuickEditEditor.redo();
    QuickEditEditor.redo();
    eq(valueOf(a) + '|' + valueOf(b), (aBefore + ' A') + '|' + (bBefore + ' B'),
       'redo replays both in order');
  }

  heading('deleting');
  {
    const island = islandFor('#p3');
    const before = valueOf(island);
    ok(backspace(island, 2), 'a backspace is not blocked');
    eq(valueOf(island), before.slice(0, -2), 'two characters are gone');
  }

  heading('entities in untouched regions');
  {
    // #p2 was edited and undone, so it is back to its original value and must
    // not be spliced at all.
    const edited = QuickEditEditor.preview();
    for (const frag of ['Smith&nbsp;&amp;&nbsp;Sons', '5 &lt; 6', '&#39;quoted&#39;']) {
      ok(edited.indexOf(frag) !== -1, 'entity run survives byte-identically: ' + frag);
    }
  }

  heading('links and forms');
  {
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    document.getElementById('link').dispatchEvent(ev);
    ok(ev.defaultPrevented, 'a link does not navigate while edit mode is on');
  }

  heading('leaving edit mode');
  {
    QuickEditEditor.setActive(false);
    ok(!QuickEditEditor.isActive(), 'edit mode turns off');
    const left = document.querySelectorAll('[data-qe-island]');
    ok(left.length > 0, 'islands holding unsaved edits are kept');
    ok(Array.prototype.every.call(left, (el) => !el.hasAttribute('contenteditable')),
       'but none of them are editable any more');

    QuickEditEditor.setActive(true);
    ok(Array.prototype.every.call(document.querySelectorAll('[data-qe-island]'),
                                 (el) => el.getAttribute('contenteditable') === 'true'),
       'turning edit mode back on re-arms them');
    QuickEditEditor.setActive(false);
  }

  heading('the file, end to end');
  {
    const edited = QuickEditEditor.preview();
    const before = new DOMParser().parseFromString(SOURCE, 'text/html');
    const after = new DOMParser().parseFromString(edited, 'text/html');

    // Two <br> elements were added over the course of the suite: one from
    // pressing Enter, one from the newline in the pasted text. Nothing else.
    eq(after.querySelectorAll('#doc *').length, before.querySelectorAll('#doc *').length + 2,
       'the document gained exactly two elements, both of them <br>');
    eq(after.querySelectorAll('#doc br').length, before.querySelectorAll('#doc br').length + 2,
       'and both additions are <br>');
    ok(edited.indexOf('<strong>bold <em>and italic</em></strong>') !== -1,
       'nested inline tags are intact');
    ok(edited.indexOf('<a href="does-not-exist.html" id="link">') !== -1,
       'attributes are intact, quoting and all');
    ok(edited.indexOf('data-qe-island') === -1,
       'not one editing wrapper leaked into the file');
    ok(edited.indexOf('contenteditable') === -1,
       'and neither did contenteditable');
  }

  Report.finish();
}

run().catch((err) => {
  line('fail', '  FAIL  suite crashed — ' + (err && err.stack || err));
  Report.finish();
});
