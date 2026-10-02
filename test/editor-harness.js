/*
 * VibeRevise — end-to-end editor tests.
 *
 * Drives real edit mode over this page's own source, through the same event
 * handlers a keypress goes through. Typing is simulated by dispatching the
 * beforeinput event, performing the mutation the browser would have performed,
 * then dispatching input — the exact contract editor.js is written against.
 * Enter, paste and formatting are not simulated at all: those code paths cancel
 * the browser's default and do the work themselves, so dispatching the event is
 * the whole story.
 *
 * The file that would be saved is checked with VibeReviseEditor.preview(), which
 * returns the spliced bytes without starting a download.
 */
'use strict';

Report.mount('out', 'summary');
const { line, heading, ok, eq, fail } = Report;

const BR = VibeReviseIslands.BR;
let SOURCE = '';

// --- simulation helpers -----------------------------------------------------

function islandFor(selector, which) {
  const host = document.querySelector(selector);
  const islands = host.querySelectorAll('[data-vr-island]');
  return islands[which || 0];
}

// The last run of text in a block — the only place Enter starts a new block.
function lastIslandFor(selector) {
  const islands = document.querySelector(selector).querySelectorAll('[data-vr-island]');
  return islands[islands.length - 1];
}

function valueOf(island) { return VibeReviseIslands.readValue(island); }

function caretTo(island, index) {
  island.focus();
  VibeReviseIslands.setCaret(island, index == null ? valueOf(island).length : index);
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

/*
 * Write into a comment card the way a person does — through its textarea, then
 * away from it — so the input and blur handlers both run and the edit is filed
 * in history properly. Setting region.text directly would leave a card focused
 * with an uncommitted edit hanging off it.
 */
function writeComment(region, text) {
  const textarea = region.card.querySelector('textarea');
  textarea.focus();
  textarea.value = text;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.blur();
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

/*
 * The single contiguous difference between two strings, as
 * { at, removed, inserted }. Used to show that adding a block REPLACES
 * NOTHING: `removed` must come back empty.
 *
 * Where exactly the insertion "starts" is ambiguous — inserting "\n  <p>x</p>"
 * in front of "\n  <p id=..." can be split at several points, all reporting the
 * same bytes rotated. So `inserted` is only used for its length here; what the
 * markup actually says is asserted against the finished file, where there is
 * nothing to be ambiguous about.
 */
function singleDiff(before, after) {
  let head = 0;
  const max = Math.min(before.length, after.length);
  while (head < max && before[head] === after[head]) head++;

  let tailBefore = before.length;
  let tailAfter = after.length;
  while (tailBefore > head && tailAfter > head &&
         before[tailBefore - 1] === after[tailAfter - 1]) {
    tailBefore--;
    tailAfter--;
  }

  return {
    at: head,
    removed: before.slice(head, tailBefore),
    inserted: after.slice(head, tailAfter),
  };
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
  const map = VibeReviseMap.build(SOURCE, document);

  heading('setup');
  ok(map.stats.editable > 0, 'the page maps to editable regions (' + map.stats.editable + ')');
  const harnessText = map.records.filter(
    (r) => r.editable && r.node.data.indexOf('Running') !== -1);
  eq(harnessText.length, 0, 'the harness UI is excluded from the map');

  VibeReviseEditor.init({ trustSynthetic: true, source: SOURCE, map, filename: 'editor-test.html' });
  VibeReviseEditor.setActive(true);
  ok(VibeReviseEditor.isActive(), 'edit mode turns on');

  const islands = document.querySelectorAll('[data-vr-island]');
  eq(islands.length, map.stats.editable, 'one island per editable region');
  ok(Array.prototype.every.call(islands, (el) => el.getAttribute('contenteditable') === 'true'),
     'every island is editable');

  heading('no edits');
  eq(VibeReviseEditor.preview(), SOURCE, 'with nothing changed, the file is byte-identical');
  eq(VibeReviseEditor.status().changed, 0, 'and nothing is reported as changed');

  heading('typing');
  {
    const island = islandFor('#p3');
    const span = map.records.find((r) => r.node === island.firstChild).span;
    ok(typeInto(island, ' Typed.'), 'a keystroke is not blocked');
    eq(valueOf(island), 'A plain paragraph to type into. Typed.', 'the island holds the new text');

    const edited = VibeReviseEditor.preview();
    ok(edited.indexOf('A plain paragraph to type into. Typed.') !== -1,
       'the typed text reaches the file');
    onlyChangedInside(edited, span, 'every byte outside the edited region is untouched');
    eq(VibeReviseEditor.status().changed, 1, 'one region is reported as changed');
  }

  heading('characters that need escaping');
  {
    const island = islandFor('#p4');
    typeInto(island, ' 5 < 6 & 7 > 2');
    const edited = VibeReviseEditor.preview();
    ok(edited.indexOf('5 &lt; 6 &amp; 7 &gt; 2') !== -1,
       'typed angle brackets and ampersands are encoded');
    ok(edited.indexOf('5 < 6 & 7 > 2') === -1, 'and never written raw');

    // The document still parses to the text the user typed, with no new tags.
    const after = new DOMParser().parseFromString(edited, 'text/html');
    ok(after.querySelector('#p4').textContent.indexOf('5 < 6 & 7 > 2') !== -1,
       'and read back as exactly what was typed');
    eq(after.querySelectorAll('#p4 *').length,
       document.querySelectorAll('#p4 [data-vr-island]').length > 0
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

    const edited = VibeReviseEditor.preview();
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
    ok(VibeReviseIslands.isClean(island), 'the island still contains only text and <br>');
  }

  heading('paste is stripped to plain text');
  {
    const island = islandFor('#p3');
    const before = valueOf(island);
    const ev = pasteInto(island, 'pasted words', '<b>pasted</b> <i>words</i>', before.length);
    ok(ev.defaultPrevented, 'the browser default paste is cancelled');
    eq(valueOf(island), before + 'pasted words', 'only the plain text is inserted');
    ok(VibeReviseIslands.isClean(island), 'no elements came in with it');
    ok(VibeReviseEditor.preview().indexOf('<b>pasted</b>') === -1,
       'the pasted markup never reaches the file');
  }

  heading('paste with line breaks');
  {
    const island = islandFor('#p3');
    const before = valueOf(island);
    pasteInto(island, 'line one\nline two', null, before.length);
    eq(valueOf(island), before + 'line one' + BR + 'line two',
       'newlines in pasted text become line breaks');
    ok(VibeReviseEditor.preview().indexOf('line one<br>line two') !== -1,
       'and are written as <br>');
  }

  heading('undo and redo');
  {
    const island = islandFor('#p2');   // the entity-bearing paragraph
    const original = valueOf(island);
    typeInto(island, '!!');
    const typed = valueOf(island);
    ok(typed !== original, 'the edit happened');

    VibeReviseEditor.undo();
    eq(valueOf(island), original, 'undo restores the previous text');
    ok(VibeReviseEditor.preview().indexOf('Smith&nbsp;&amp;&nbsp;Sons, 5 &lt; 6, &#39;quoted&#39;') !== -1,
       'and the entities are back to the original bytes');

    VibeReviseEditor.redo();
    eq(valueOf(island), typed, 'redo puts the edit back');

    VibeReviseEditor.undo();
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
    VibeReviseEditor.undo();
    eq(valueOf(b), bBefore, 'undo steps back into the most recent region');
    eq(valueOf(a), aBefore + ' A', 'and leaves the earlier one alone');
    VibeReviseEditor.undo();
    eq(valueOf(a), aBefore, 'the next undo steps back into the earlier region');
    VibeReviseEditor.redo();
    VibeReviseEditor.redo();
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
    const edited = VibeReviseEditor.preview();
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
    VibeReviseEditor.setActive(false);
    ok(!VibeReviseEditor.isActive(), 'edit mode turns off');
    const left = document.querySelectorAll('[data-vr-island]');
    ok(left.length > 0, 'islands holding unsaved edits are kept');
    ok(Array.prototype.every.call(left, (el) => !el.hasAttribute('contenteditable')),
       'but none of them are editable any more');

    VibeReviseEditor.setActive(true);
    ok(Array.prototype.every.call(document.querySelectorAll('[data-vr-island]'),
                                 (el) => el.getAttribute('contenteditable') === 'true'),
       'turning edit mode back on re-arms them');
    VibeReviseEditor.setActive(false);
  }

  heading('comments — one that was already in the file');
  {
    const regions = VibeReviseEditor.commentRegions();
    const existing = regions.find((r) => r.text === 'this note was already in the file');
    ok(!!existing, 'a comment already in the file is picked up');
    ok(existing && existing.block === document.getElementById('p6'),
       'and is attached to the section that follows it');
    eq(VibeReviseEditor.preview(), VibeReviseEditor.preview(),
       'reading it changes nothing');
    ok(VibeReviseEditor.preview().indexOf('<!-- comment: this note was already in the file -->') !== -1,
       'and it is still in the file, untouched');
  }

  heading('comments — adding one');
  {
    const before = VibeReviseEditor.preview();
    const region = VibeReviseEditor.addCommentTo(document.getElementById('p3'));
    ok(!!region, 'a comment was added');
    eq(VibeReviseEditor.preview(), before, 'an empty comment is not written to the file');

    writeComment(region, 'needs a figure for Q3');
    const after = VibeReviseEditor.preview();
    const diff = singleDiff(before, after);
    eq(diff.removed, '', 'adding a comment REPLACES NOTHING — not one byte');
    ok(after.indexOf('<!-- comment: needs a figure for Q3 -->\n  <p id="p3">') !== -1,
       'it lands on its own line, immediately before the section it belongs to');

    // The point of storing it this way: a browser shows none of it.
    const rendered = new DOMParser().parseFromString(after, 'text/html');
    const wasRendered = new DOMParser().parseFromString(before, 'text/html');
    eq(rendered.querySelectorAll('#doc *').length,
       wasRendered.querySelectorAll('#doc *').length,
       'the visible document is unchanged — not one new element');
    ok(rendered.body.textContent.indexOf('needs a figure for Q3') === -1,
       'and the note is invisible to anyone reading the page');
  }

  heading('comments — editing and deleting');
  {
    const regions = VibeReviseEditor.commentRegions();
    const existing = regions.find((r) => r.original === 'this note was already in the file');

    writeComment(existing, 'rewritten note');
    const edited = VibeReviseEditor.preview();
    ok(edited.indexOf('<!-- comment: rewritten note -->') !== -1, 'an existing comment can be rewritten');
    ok(edited.indexOf('this note was already in the file') === -1, 'the old text is gone');

    VibeReviseEditor.removeComment(existing);
    const deleted = VibeReviseEditor.preview();
    ok(deleted.indexOf('<!-- comment: rewritten note -->') === -1, 'and it can be deleted');
    ok(deleted.indexOf('<p id="p6">') !== -1, 'the section it was attached to stays');
    ok(deleted.indexOf('\n\n  <p id="p6">') === -1,
       'deleting takes the whole line, leaving no blank gap behind');

    VibeReviseEditor.undo();
    ok(VibeReviseEditor.preview().indexOf('<!-- comment: rewritten note -->') !== -1,
       'undo brings a deleted comment back');
    VibeReviseEditor.undo();
    ok(VibeReviseEditor.preview().indexOf('this note was already in the file') !== -1,
       'and undoing again puts its original wording back');
    VibeReviseEditor.redo();
  }

  heading('comments — who wrote them');
  {
    VibeReviseEditor.setAuthor('Cara');
    const region = VibeReviseEditor.addCommentTo(document.getElementById('p4'));
    writeComment(region, 'check this figure');
    const out = VibeReviseEditor.preview();
    ok(/<!-- comment \[Cara \u00b7 \d{4}-\d{2}-\d{2}\]: check this figure -->/.test(out),
       'a comment written with a name set carries the name and the day');

    // The note that arrived unsigned, edited above while no name was set, is
    // still somebody else's comment — having a name now must not sign it.
    ok(out.indexOf('<!-- comment: rewritten note -->') !== -1,
       'an existing unsigned note, edited, is not signed with the current name');

    VibeReviseEditor.setAuthor('');
    ok(VibeReviseEditor.status().author === '', 'and the name can be cleared again');
    VibeReviseEditor.removeComment(region);
  }

  heading('comments — a note that would break out of a comment');
  {
    const region = VibeReviseEditor.addCommentTo(document.getElementById('p1'));
    writeComment(region, 'see --> here, and a trailing dash-');
    const out = VibeReviseEditor.preview();

    // Exactly one "-->" belongs to this comment: the one that closes it.
    const start = out.indexOf('<!-- comment: see');
    const body = out.slice(start, out.indexOf('-->', start) + 3);
    ok(body.indexOf('-->') === body.length - 3,
       'the note cannot close its own comment early');
    ok(new DOMParser().parseFromString(out, 'text/html').getElementById('p1') !== null,
       'and the document after it still parses');
  }

  heading('comments — replies are notes that share a section');
  {
    const before = VibeReviseEditor.preview();
    const first = VibeReviseEditor.addCommentTo(document.getElementById('p5'));
    writeComment(first, 'Is this number right?');
    const reply = VibeReviseEditor.addCommentTo(document.getElementById('p5'));
    writeComment(reply, 'Checked it — yes.');

    const out = VibeReviseEditor.preview();
    eq(singleDiff(before, out).removed, '', 'a thread replaces nothing in the file');

    const asked = out.indexOf('Is this number right?');
    const answered = out.indexOf('Checked it — yes.');
    ok(asked !== -1 && answered !== -1, 'both notes are written');
    ok(asked < answered, 'the reply follows the note it answers');
    ok(answered < out.indexOf('<p class="note" id="p5">'),
       'and the whole thread sits before the section it is about');

    // Nothing in the file marks a reply; it is one because it shares a block.
    ok(VibeReviseEditor.commentRegions().filter((r) => r.block === document.getElementById('p5'))
       .length === 2, 'both notes are attached to the same section');
  }

  heading('comments — the visible form says the same thing');
  {
    const hidden = VibeReviseEditor.preview();
    ok(hidden.indexOf('data-vr-comment') === -1, 'notes are invisible by default');

    VibeReviseEditor.setCommentsVisible(true);
    const shown = VibeReviseEditor.preview();
    ok(shown.indexOf('<!-- comment') === -1, 'turning it on leaves no hidden notes behind');

    const page = new DOMParser().parseFromString(shown, 'text/html');
    const notes = page.querySelectorAll('[data-vr-comment]');
    ok(notes.length > 1, 'every note became an element a browser will show (' + notes.length + ')');
    ok(page.body.textContent.indexOf('Is this number right?') !== -1,
       'and the words are now readable without VibeRevise');

    // The round trip is the whole reason this is safe to offer as a switch.
    const asked = [...notes].find((n) => n.textContent.indexOf('Is this number right?') !== -1);
    const parsed = VibeReviseComments.parseElement(asked);
    eq(parsed.text, 'Is this number right?', 'the note reads back with its words intact');
    ok(shown.indexOf('style="') !== -1, 'styled inline, so it needs no stylesheet to look right');
    // A double quote anywhere in that style would end the attribute early and
    // spill the rest of it into the document as stray text. "Segoe UI" did
    // exactly that until the font stack was quoted with apostrophes.
    ok(/sans-serif/.test(asked.getAttribute('style')),
       'and the whole style survived being put in an attribute');
    ok(asked.textContent.indexOf('Segoe') === -1,
       'with none of it spilled into the words the reader sees');

    // An author survives the trip through the attribute.
    const signed = [...notes].find((n) => n.getAttribute('data-vr-comment'));
    if (signed) {
      const back = VibeReviseComments.parseElement(signed);
      ok(!!(back.author || back.date), 'and so does who wrote it, and when');
    }

    /*
     * The part that decides whether this is a feature or a trap: reopening the
     * saved file has to find the note's own range, start tag to end tag, or it
     * could never be edited, deleted or switched back again.
     */
    const reopened = VibeReviseMap.build(shown, page);
    const tags = reopened.elements.get(asked);
    ok(!!(tags && tags.startTag && tags.endTag),
       'reopening the file finds the note\'s range in it');
    const slice = shown.slice(tags.startTag.start, tags.endTag.end);
    ok(slice.indexOf('Is this number right?') !== -1 && slice.indexOf('</div>') === slice.length - 6,
       'and that range is exactly the note, nothing more');

    // A visible note is the editor's own, not the author's prose, so it must
    // not also turn up as a paragraph the user can type into.
    const editableInside = reopened.records.filter(
      (r) => r.editable && asked.contains(r.node));
    eq(editableInside.length, 0, 'and it is not offered as editable text as well');

    VibeReviseEditor.setCommentsVisible(false);
    eq(VibeReviseEditor.preview(), hidden,
       'and turning it off again restores the file byte for byte');
  }

  heading('the file, end to end');
  {
    const edited = VibeReviseEditor.preview();
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
    ok(edited.indexOf('data-vr-island') === -1,
       'not one editing wrapper leaked into the file');
    ok(edited.indexOf('contenteditable') === -1,
       'and neither did contenteditable');
  }

  heading('adding a block');
  {
    VibeReviseEditor.setActive(true);

    const before = VibeReviseEditor.preview();
    const island = islandFor('#p3');
    const added = VibeReviseEditor.addAfterIsland(island);
    ok(!!added, 'a block was added');

    const p3 = document.getElementById('p3');
    const fresh = p3.nextElementSibling;
    eq(fresh.localName, 'p', 'the new element has the same tag as its neighbour');
    eq(fresh.textContent, '', 'and starts empty');
    eq(VibeReviseEditor.preview(), before,
       'an added block with nothing typed into it is not written to the file');

    typeInto(fresh.querySelector('[data-vr-island]'), 'A brand new paragraph.');
    const after = VibeReviseEditor.preview();
    const diff = singleDiff(before, after);

    eq(diff.removed, '', 'adding a block REPLACES NOTHING — not one byte');
    eq(diff.inserted.length, '\n  <p>A brand new paragraph.</p>'.length,
       'and adds exactly the new block, nothing more');
    ok(after.indexOf('</p>\n  <p>A brand new paragraph.</p>\n  <p id="p4"') !== -1,
       'which lands between its neighbour and the next block, indented to match');
    ok(after.indexOf('<p id="p3">') !== -1, 'the block it was added after is untouched');
  }

  heading('adding — id is dropped, class is kept');
  {
    const before = VibeReviseEditor.preview();
    VibeReviseEditor.addAfterIsland(islandFor('#p5'));
    const fresh = document.getElementById('p5').nextElementSibling;
    typeInto(fresh.querySelector('[data-vr-island]'), 'Copied styling.');

    const afterAdd = VibeReviseEditor.preview();
    eq(singleDiff(before, afterAdd).removed, '', 'still replaces nothing');
    ok(afterAdd.indexOf('\n  <p class="note">Copied styling.</p>') !== -1,
       'the class comes along');
    ok(afterAdd.indexOf('<p class="note">Copied styling.</p>') !== -1 &&
       afterAdd.indexOf('id="p5">Copied styling') === -1,
       'the id does not, so it stays unique');
  }

  heading('adding — inside a list');
  {
    const before = VibeReviseEditor.preview();
    const items = document.querySelectorAll('#list li');
    const first = items[0];
    VibeReviseEditor.addAfterIsland(first.querySelector('[data-vr-island]'));

    const fresh = first.nextElementSibling;
    eq(fresh.localName, 'li', 'an <li> gets another <li>, not a <p>');
    typeInto(fresh.querySelector('[data-vr-island]'), 'Inserted item');

    const afterAdd = VibeReviseEditor.preview();
    eq(singleDiff(before, afterAdd).removed, '', 'still replaces nothing');
    ok(afterAdd.indexOf(
         '<li>First item</li>\n    <li>Inserted item</li>\n    <li>Second item</li>') !== -1,
       'and lands between the two existing items, with the list\'s own indent');
  }

  heading('adding — Enter breaks the line, except in a list');
  {
    // #p4 is "Another <span>paragraph</span> with an inline span." — three runs
    // of text. Even at the very end of the last one, which IS the end of the
    // block, Enter stays in the paragraph and breaks the line.
    const island = lastIslandFor('#p4');
    const value = valueOf(island);
    const blocksBefore = document.querySelectorAll('#doc p').length;

    const ev = dispatchBeforeInput(island, 'insertParagraph', value.length);
    ok(ev.defaultPrevented, 'the browser default is cancelled');
    eq(document.querySelectorAll('#doc p').length, blocksBefore,
       'Enter at the end of a paragraph does not start another paragraph');
    eq(valueOf(island), value + BR, 'it breaks the line instead');

    // The same key at the end of a run that is NOT the end of its block does
    // the same thing.
    const firstRun = islandFor('#p4');
    const firstValue = valueOf(firstRun);
    dispatchBeforeInput(firstRun, 'insertParagraph', firstValue.length);
    eq(valueOf(firstRun), firstValue + BR,
       'Enter at the end of an inline run mid-block inserts a line break');

    // Mid-text, the same key still breaks the line.
    const mid = islandFor('#p1');
    const midValue = valueOf(mid);
    dispatchBeforeInput(mid, 'insertParagraph', 2);
    eq(valueOf(mid), midValue.slice(0, 2) + BR + midValue.slice(2),
       'Enter in the middle of a run still inserts a line break');

    // A bullet is the exception: finishing one means starting the next.
    const bullet = lastIslandFor('#list li:last-child');
    const bulletValue = valueOf(bullet);
    const itemsBefore = document.querySelectorAll('#list li').length;

    dispatchBeforeInput(bullet, 'insertParagraph', bulletValue.length);
    eq(document.querySelectorAll('#list li').length, itemsBefore + 1,
       'Enter at the end of a list item adds the next item');
    eq(valueOf(bullet), bulletValue, 'and leaves the item it came from alone');

    // Mid-bullet it still just breaks the line.
    const midBullet = islandFor('#list li');
    const midBulletValue = valueOf(midBullet);
    dispatchBeforeInput(midBullet, 'insertParagraph', 1);
    eq(valueOf(midBullet), midBulletValue.slice(0, 1) + BR + midBulletValue.slice(1),
       'Enter in the middle of a list item still inserts a line break');
  }

  heading('adding — undo and redo');
  {
    const before = VibeReviseEditor.preview();
    const countBefore = document.querySelectorAll('#doc p').length;

    VibeReviseEditor.addAfterIsland(islandFor('#p3'));
    const fresh = document.getElementById('p3').nextElementSibling;
    typeInto(fresh.querySelector('[data-vr-island]'), 'Temporary.');
    ok(VibeReviseEditor.preview() !== before, 'the addition is in the file');

    VibeReviseEditor.undo();            // the typing
    VibeReviseEditor.undo();            // the block itself
    eq(document.querySelectorAll('#doc p').length, countBefore,
       'undo takes the added block back out of the page');
    eq(VibeReviseEditor.preview(), before, 'and out of the file');

    VibeReviseEditor.redo();            // the block
    VibeReviseEditor.redo();            // the typing
    eq(document.querySelectorAll('#doc p').length, countBefore + 1,
       'redo puts it back');
    ok(VibeReviseEditor.preview().indexOf('Temporary.') !== -1, 'with its text');

    VibeReviseEditor.undo();
    VibeReviseEditor.undo();
    eq(VibeReviseEditor.preview(), before, 'and undo removes it again');
  }

  heading('adding — after a block that was itself added');
  {
    const before = VibeReviseEditor.preview();

    VibeReviseEditor.addAfterIsland(islandFor('#p3'));
    const firstNew = document.getElementById('p3').nextElementSibling;
    typeInto(firstNew.querySelector('[data-vr-island]'), 'One.');

    VibeReviseEditor.addAfterIsland(firstNew.querySelector('[data-vr-island]'));
    const secondNew = firstNew.nextElementSibling;
    typeInto(secondNew.querySelector('[data-vr-island]'), 'Two.');

    const afterAdd = VibeReviseEditor.preview();
    eq(singleDiff(before, afterAdd).removed, '', 'two additions at one anchor still replace nothing');
    ok(afterAdd.indexOf('\n  <p>One.</p>\n  <p>Two.</p>') !== -1,
       'and come out in the order they appear on the page');
  }

  heading('inserting a structure — cloned from the document');
  {
    // Anchor the insertion somewhere known: currentBlock() follows the caret.
    caretTo(islandFor('#p5'), 0);
    const before = VibeReviseEditor.preview();

    const tree = VibeReviseEditor.insertStructure('table');
    ok(!!tree, 'a table was inserted');
    eq(tree.element.getAttribute('class'), 'grid', 'it took the donor table\'s class');
    eq(tree.cells.length, 6,
       'two columns from the donor: a header row and two body rows');
    ok(!!tree.element.querySelector('thead'),
       'and a header row, because the donor has one');
    eq(tree.element.previousElementSibling.id, 'p5', 'it landed after the caret\'s block');

    eq(VibeReviseEditor.preview(), before,
       'a structure nobody has typed into is not written to the file at all');

    const cells = tree.cells.map((c) => c.island);
    typeInto(cells[0], 'Measure');
    typeInto(cells[1], 'Target');
    typeInto(cells[2], 'Alpha');
    typeInto(cells[3], 'one');
    typeInto(cells[4], 'Beta');
    typeInto(cells[5], 'two');

    const edited = VibeReviseEditor.preview();
    const diff = singleDiff(before, edited);
    eq(diff.removed, '', 'the whole table is one insertion that replaces nothing');

    ok(edited.indexOf('<table class="grid">') !== -1, 'the table tag carries the class');
    ok(edited.indexOf('<th>Measure</th>') !== -1, 'header cells are written');
    ok(edited.indexOf('<td>Alpha</td>') !== -1, 'body cells are written');
    ok(edited.indexOf('<td>two</td>') !== -1, 'every row is written');
    ok(edited.indexOf('data-vr-island') === -1, 'no editing wrapper reached the file');
    // Indented relative to the block it was added after, which sits at two
    // spaces in this document.
    ok(edited.indexOf('\n  <table class="grid">\n    <thead>\n      <tr>\n        <th>Measure</th>') !== -1,
       'and it is laid out and indented like the markup around it');
  }

  heading('inserting a structure — it goes where the caret was, not where focus is');
  {
    // The real complaint this fixes: pressing Insert moves focus to the
    // toolbar, so activeElement is no longer the text being edited. What the
    // user means is the last place the caret actually was.
    caretTo(islandFor('#p2'), 0);
    const island = islandFor('#p2');
    island.blur();                       // exactly what pressing a button does
    ok(document.activeElement !== island, 'focus has left the text, as it would');

    const tree = VibeReviseEditor.insertStructure('paragraph');
    ok(!!tree, 'a paragraph was inserted');
    eq(tree.element.previousElementSibling.id, 'p2',
       'and it landed after the block the caret was last in');
  }

  heading('inserting a structure — at the block the + belongs to');
  {
    // The hover controls sit beside a block, so what they insert goes there,
    // whatever the caret happens to be doing. That is the whole reason for
    // offering the menu from the + rather than only from the toolbar.
    caretTo(islandFor('#p3'), 0);          // caret deliberately somewhere else
    const target = document.querySelector('#p1');
    const tree = VibeReviseEditor.insertStructure('bullets', target);
    ok(!!tree, 'a list was inserted');
    eq(tree.element.previousElementSibling.id, 'p1',
       'directly after the block it was opened from, not where the caret was');

    typeInto(tree.cells[0].island, 'From the plus.');
    ok(VibeReviseEditor.preview().indexOf('<li>From the plus.</li>') !== -1,
       'and it reaches the file');
  }

  heading('inserting a structure — a skeleton when there is nothing to clone');
  {
    ok(!document.querySelector('#doc blockquote'),
       'the document has no blockquote to copy');
    caretTo(islandFor('#p3'), 0);
    const tree = VibeReviseEditor.insertStructure('quote');
    ok(!!tree, 'a quote was still inserted');
    eq(tree.element.getAttribute('class'), null, 'with no class, because there was none to take');
    eq(tree.cells.length, 1, 'and one run of text to type into');

    typeInto(tree.cells[0].island, 'Nothing to copy here.');
    ok(VibeReviseEditor.preview().indexOf('<blockquote>Nothing to copy here.</blockquote>') !== -1,
       'and it is written as a plain blockquote');
  }

  heading('inserting a structure — undo takes the whole thing back out');
  {
    caretTo(islandFor('#p3'), 0);
    const before = VibeReviseEditor.preview();
    const tree = VibeReviseEditor.insertStructure('bullets');
    typeInto(tree.cells[0].island, 'A bullet.');
    ok(VibeReviseEditor.preview().indexOf('<li>A bullet.</li>') !== -1, 'the list is in the file');

    VibeReviseEditor.undo();       // the typing
    VibeReviseEditor.undo();       // the insertion
    ok(!tree.element.isConnected, 'undo removed the list from the page');
    eq(VibeReviseEditor.preview(), before, 'and the file is back to what it was');

    VibeReviseEditor.redo();
    ok(tree.element.isConnected, 'redo put it back');
    VibeReviseEditor.undo();       // leave the document as we found it
  }

  // Pressing a key on whatever has focus: the editor listens on the document,
  // so this reaches it the same way a real key press would.
  function press(key, opts) {
    return document.activeElement.dispatchEvent(new KeyboardEvent('keydown',
      Object.assign({ key: key, bubbles: true, cancelable: true }, opts || {})));
  }

  heading('a freshly inserted thing goes away again on Esc or Delete');
  {
    caretTo(islandFor('#p3'), 0);
    const before = VibeReviseEditor.preview();

    const table = VibeReviseEditor.insertStructure('table');
    ok(table.element.isConnected, 'a table was inserted');
    ok(!press('Escape'), 'Esc was handled rather than left to the page');
    ok(!table.element.isConnected, 'and the table is gone');
    eq(VibeReviseEditor.preview(), before, 'the file is untouched');

    caretTo(islandFor('#p3'), 0);
    const list = VibeReviseEditor.insertStructure('bullets');
    ok(list.element.isConnected, 'a list was inserted');
    press('Backspace');
    ok(!list.element.isConnected, 'Backspace removes it too');

    caretTo(islandFor('#p3'), 0);
    const para = VibeReviseEditor.insertStructure('paragraph');
    press('Delete');
    ok(!para.element.isConnected, 'and so does Delete');
    eq(VibeReviseEditor.preview(), before, 'after all three, the file is still untouched');

    // Undoing a removal is itself undoable, because it went through undo().
    VibeReviseEditor.redo();
    ok(para.element.isConnected, 'a press made by mistake is recoverable with redo');
    VibeReviseEditor.undo();
  }

  heading('once something has been typed into it, the keys go back to normal');
  {
    caretTo(islandFor('#p3'), 0);
    const tree = VibeReviseEditor.insertStructure('quote');
    typeInto(tree.cells[0].island, 'Mine now.');

    ok(press('Escape'), 'Esc is left alone');
    ok(tree.element.isConnected, 'and the quote stays, because it holds the user\'s words');

    press('Backspace');
    ok(tree.element.isConnected, 'Backspace stays an ordinary Backspace');

    VibeReviseEditor.undo();       // the typing
    VibeReviseEditor.undo();       // the insertion
  }

  heading('an empty added item goes on Delete wherever it is, not only the newest');
  {
    // The user's case: click back into something they added earlier, find it
    // still empty, press Delete.
    caretTo(islandFor('#p3'), 0);
    const tree = VibeReviseEditor.insertStructure('table');
    typeInto(islandFor('#p3'), '!');      // something else is now the last thing done
    const withTyping = VibeReviseEditor.preview();

    caretTo(tree.cells[0].island, 0);
    press('Escape');
    ok(tree.element.isConnected, 'Esc does not remove an older one — Esc cancels, it does not delete');

    ok(!press('Delete'), 'Delete is handled in an empty added table');
    ok(!tree.element.isConnected, 'and the table is removed, though it was not the last thing added');
    eq(VibeReviseEditor.preview(), withTyping, 'nothing else in the file moved');
    ok(document.activeElement && document.activeElement.hasAttribute('data-vr-island'),
       'the caret lands in the text beside it rather than nowhere');

    VibeReviseEditor.undo();
    ok(tree.element.isConnected, 'one undo brings it back');
    VibeReviseEditor.redo();
    ok(!tree.element.isConnected, 'and redo removes it again');
    VibeReviseEditor.undo();               // the removal
    VibeReviseEditor.undo();               // the typing
    VibeReviseEditor.undo();               // the insertion
  }

  heading('the same for a paragraph added with the +');
  {
    const region = VibeReviseEditor.addAfterIsland(islandFor('#p3'));
    ok(!!region && region.element.isConnected, 'the + added a paragraph');
    typeInto(islandFor('#p3'), '?');      // not the newest any more
    caretTo(region.island, 0);
    press('Delete');
    ok(!region.element.isConnected, 'and Delete in it, empty, removes it');
    VibeReviseEditor.undo();
    ok(region.element.isConnected, 'undo brings it back');
    VibeReviseEditor.undo();               // the typing
    VibeReviseEditor.undo();               // the addition
  }

  heading('an added paragraph with words in it is not removed');
  {
    caretTo(islandFor('#p3'), 0);
    const para = VibeReviseEditor.insertStructure('paragraph');
    typeInto(para.cells[0].island, 'Kept.');
    typeInto(islandFor('#p3'), '!');
    caretTo(para.cells[0].island, 0);
    press('Delete');
    ok(para.element.isConnected, 'Delete is an ordinary Delete once there are words in it');
    VibeReviseEditor.undo();
    VibeReviseEditor.undo();
    VibeReviseEditor.undo();
  }

  heading('nothing that came from the file is ever removed by a key');
  {
    // The case this must not get wrong: emptying a paragraph that was in the
    // file is editing it, and Delete in it must stay an ordinary Delete.
    const island = islandFor('#p2');
    const value = valueOf(island);
    backspace(island, value.length, value.length);
    eq(valueOf(island), '', 'an existing paragraph has been emptied');
    press('Delete');
    press('Backspace');
    ok(document.getElementById('p2').isConnected, 'and it is still there, by both keys');
    VibeReviseEditor.undo();
    eq(valueOf(islandFor('#p2')), value, 'undo puts its words back');
  }

  heading('adding — the file still parses to what is on screen');
  {
    const edited = VibeReviseEditor.preview();
    const reparsed = new DOMParser().parseFromString(edited, 'text/html');
    ok(edited.indexOf('data-vr-island') === -1, 'no editing wrapper leaked into the file');
    ok(edited.indexOf('contenteditable') === -1, 'and neither did contenteditable');
    // The page carries one block per empty addition that the file deliberately
    // leaves out.
    eq(reparsed.querySelectorAll('#doc p, #doc li').length,
       document.querySelectorAll('#doc p, #doc li').length - VibeReviseEditor.status().emptyAdded,
       'the file has the page\'s blocks, less the empty ones it declines to write');
  }

  // --- saving through a host that owns the file -----------------------------

  /*
   * The extension's picker route and the web app both hand the editor a
   * saveFile(). What matters is not that it works — it is what happens when it
   * does not, because by then the user has edits on screen and nowhere to put
   * them. Re-init only replaces saveFile; the regions built at the top of this
   * suite are left alone.
   */
  function withSaveFile(fn) {
    const calls = [];
    VibeReviseEditor.init({ trustSynthetic: true,
      source: SOURCE, map, filename: 'editor-test.html',
      saveFile: (text) => { calls.push(text); return fn(text); },
    });
    return calls;
  }

  heading('saving — a host that writes the file keeps the edits');
  {
    const island = islandFor('#p3');
    const calls = withSaveFile(() => ({ ok: true, where: 'Saved over editor-test.html' }));

    // Settle first. Every heading above has edited this page, so the only
    // honest baseline is whatever remains once a save has been allowed to
    // succeed — and the count is then measured as a change from it.
    await VibeReviseEditor.save();
    const floor = VibeReviseEditor.status().unsaved;

    typeInto(island, 'Written. ', 0);
    eq(VibeReviseEditor.status().unsaved, floor + 1, 'there is something to save');

    await VibeReviseEditor.save();
    eq(calls.length, 2, 'the host was asked to write the file');
    ok(calls[1].indexOf('Written. ') !== -1, 'and was given the edited file');
    eq(VibeReviseEditor.status().unsaved, floor, 'the edit counts as saved');
  }

  heading('saving — a host that cannot write falls back to the download');
  {
    const island = islandFor('#p3');
    const calls = withSaveFile(() => ({
      ok: false, fallback: true, message: 'the handle went away',
    }));
    const floor = VibeReviseEditor.status().unsaved;

    typeInto(island, 'Rescued. ', 0);
    eq(VibeReviseEditor.status().unsaved, floor + 1, 'there is something to save');

    await VibeReviseEditor.save();
    eq(calls.length, 1, 'the host was asked first');
    eq(VibeReviseEditor.status().unsaved, floor,
       'and the download caught the edit rather than losing it');
  }

  heading('saving — a refusal without fallback keeps the edits on screen');
  {
    // Cancelling a save dialog is a refusal, not a failure. Downloading the
    // file anyway would be the opposite of what the user just asked for, so
    // the edit stays unsaved and visibly so.
    const island = islandFor('#p3');
    const calls = withSaveFile(() => ({ ok: false, message: 'cancelled' }));
    const floor = VibeReviseEditor.status().unsaved;

    typeInto(island, 'Kept. ', 0);
    await VibeReviseEditor.save();
    eq(calls.length, 1, 'the host was asked');
    eq(VibeReviseEditor.status().unsaved, floor + 1,
       'nothing was marked saved, and nothing was downloaded behind the user');
  }

  heading('comments — a deleted note stops counting as unsaved once it is saved');
  {
    /*
     * The bug this covers: a save recorded a note's TEXT as saved but never
     * the fact that it had been removed, so a deleted comment counted as
     * unsaved for ever. The status bar claimed pending work after a save that
     * had plainly succeeded, and the unload warning kept firing over it.
     */
    withSaveFile(() => ({ ok: true, where: 'saved' }));
    await VibeReviseEditor.save();
    const floor = VibeReviseEditor.status().unsaved;

    const region = VibeReviseEditor.addCommentTo(document.getElementById('p2'));
    writeComment(region, 'temporary note');
    await VibeReviseEditor.save();
    eq(VibeReviseEditor.status().unsaved, floor, 'a new note saves');
    ok(VibeReviseEditor.preview().indexOf('temporary note') !== -1, 'and is in the file');

    VibeReviseEditor.removeComment(region);
    eq(VibeReviseEditor.status().unsaved, floor + 1, 'deleting it is an unsaved change');

    await VibeReviseEditor.save();
    eq(VibeReviseEditor.status().unsaved, floor,
       'and saving settles it, rather than counting for ever');
    ok(VibeReviseEditor.preview().indexOf('temporary note') === -1,
       'the note is gone from the file');
  }

  heading('comments — moving the switch is itself an unsaved change');
  {
    withSaveFile(() => ({ ok: true, where: 'saved' }));
    await VibeReviseEditor.save();
    const floor = VibeReviseEditor.status().unsaved;
    const inFile = VibeReviseEditor.commentRegions().length;
    ok(inFile > 0, 'there are notes in the file to rewrite');

    VibeReviseEditor.setCommentsVisible(true);
    eq(VibeReviseEditor.status().unsaved, floor + inFile,
       'every note in the file is pending, because every one of them changes');

    VibeReviseEditor.setCommentsVisible(false);
    eq(VibeReviseEditor.status().unsaved, floor,
       'and moving it back means nothing is pending after all');
  }

  heading('a page cannot drive the editor by forging events');
  {
    /*
     * The whole suite runs with trustSynthetic on, because a test can only
     * produce synthetic events. That makes the guard the one thing the suite
     * would otherwise never exercise, so this turns it off and pushes from the
     * side a hostile page would be on.
     *
     * The threat is specific to editing a page the user did not write: forged
     * Ctrl+S raises a Save dialog nobody asked for, forged Ctrl+Z throws away
     * their work, and forged input puts the page's words into the document to
     * be saved as if the user had typed them.
     *
     * Everything is measured against preview() — the bytes Save would write —
     * because that is the guarantee. What a page can scribble into its own DOM
     * is its business; what matters is that none of it reaches the file.
     */
    const island = islandFor('#p3');
    const fileBefore = VibeReviseEditor.preview();
    const unsavedBefore = VibeReviseEditor.status().unsaved;
    const calls = withSaveFile(() => ({ ok: true, where: 'saved' }));

    // Hostile from here: no trustSynthetic, as in the extension.
    VibeReviseEditor.init({ source: SOURCE, map, filename: 'editor-test.html' });

    /*
     * Events only, with no DOM write — which is exactly what a page can do.
     * Forging beforeinput does not make a contenteditable mutate; only the
     * browser does that. What the page is trying for here is to have the
     * editor record a change it never made.
     */
    caretTo(island, 0);
    for (const type of ['beforeinput', 'input']) {
      island.dispatchEvent(new InputEvent(type, {
        inputType: 'insertText', data: 'INJECTED ', bubbles: true, cancelable: true,
      }));
    }
    eq(VibeReviseEditor.preview(), fileBefore,
       'forged input is not recorded as something the user typed');
    eq(VibeReviseEditor.status().unsaved, unsavedBefore,
       'and is not counted as something the user typed');

    await VibeReviseEditor.save();
    eq(calls.length, 0, 'a forged Ctrl/Cmd+S cannot make the editor save');

    press('z', { ctrlKey: true });
    press('y', { ctrlKey: true });
    eq(VibeReviseEditor.preview(), fileBefore,
       'and forged undo and redo cannot throw work away or bring it back');

    press('Delete');
    press('Backspace');
    press('Escape');
    press('Enter', { ctrlKey: true });
    eq(VibeReviseEditor.preview(), fileBefore,
       'nor can Delete, Backspace, Esc or Ctrl+Enter change the file');

    // Back to a suite that can drive itself.
    VibeReviseEditor.init({ trustSynthetic: true, source: SOURCE, map, filename: 'editor-test.html' });
    eq(VibeReviseEditor.preview(), fileBefore, 'and the file is exactly as it was');
  }

  heading('the list of changes shows which words changed');
  {
    /*
     * This regressed silently when AI rewrites were removed: diffWords lived
     * in that module, so the changes list quietly fell back to one whole
     * "before" and one whole "after". Nothing failed, the README still
     * promised word by word, and nobody noticed until the rename walked past
     * a helper that could only ever return null.
     */
    const d = VibeReviseEditor.diffWords(
      'Revenue grew by 12% over the quarter.',
      'Revenue rose 12% this quarter.');

    const without = (op) => d.filter((p) => p.op !== op).map((p) => p.text).join('');
    eq(without('add'), 'Revenue grew by 12% over the quarter.',
       'dropping the additions gives back the original, whitespace and all');
    eq(without('del'), 'Revenue rose 12% this quarter.',
       'and dropping the removals gives the new wording');
    ok(d.some((p) => p.op === 'same' && p.text.indexOf('12%') !== -1),
       'the words that did not change are marked as unchanged');
    ok(d.some((p) => p.op === 'del') && d.some((p) => p.op === 'add'),
       'and the ones that did are marked on both sides');

    // Identical text has nothing to report, and a diff against nothing is all
    // addition — the two ends the changes list actually hits.
    const same = VibeReviseEditor.diffWords('No change here.', 'No change here.');
    ok(same.every((p) => p.op === 'same'), 'identical text is entirely unchanged');
    eq(VibeReviseEditor.diffWords('', 'All new.').map((p) => p.op).join(),
       'add', 'and text added from nothing is entirely an addition');
  }

  // Put the editor back the way the rest of the page expects it.
  VibeReviseEditor.init({ trustSynthetic: true, source: SOURCE, map, filename: 'editor-test.html' });

  Report.finish();
}

run().catch((err) => {
  fail('  FAIL  suite crashed — ' + (err && err.stack || err));
  Report.finish();
});
