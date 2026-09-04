/*
 * Quick Edit — offset mapping test suite.
 *
 * Run it in a browser (see test/README.md) or headlessly via test/run.sh.
 *
 * Each fixture is loaded twice, on purpose:
 *
 *   1. In an <iframe> from its real file:// URL. That is the authoritative
 *      parse — same parser, same scripting-enabled state, same everything as
 *      the page the extension will actually run on. Used to check that the map
 *      matches reality: every text node found, every pair verified.
 *
 *   2. Through DOMParser, twice over (once for the original source, once for
 *      the edited source). Two documents produced the same way can be compared
 *      element for element and text node for text node, which is what makes the
 *      "edit everything and check nothing else moved" test meaningful.
 *
 * The claim being tested throughout: a saved file differs from the original
 * only in the spans the user deliberately changed.
 */
'use strict';

const FIXTURES = [
  'simple.html',
  'nested-inline.html',
  'entities.html',
  'comments-doctype.html',
  'messy.html',
  'scripty.html',
  'pre-template.html',
  'crlf.html',
  'large.html',
];

Report.mount('out', 'summary');
const { line, heading, ok, eq, tally } = Report;

// --- helpers ---------------------------------------------------------------

function parse(html) {
  return new DOMParser().parseFromString(html, 'text/html');
}

// Everything about a document EXCEPT its text: tags, attributes, comments,
// doctype, and the tree shape. If a text edit disturbs any of this, we broke
// the promise.
function signature(doc) {
  const parts = [];
  (function walk(node) {
    for (let n = node.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 1) {
        const attrs = Array.from(n.attributes)
          .map((a) => a.name + '=' + a.value).sort().join(' ');
        parts.push('<' + n.nodeName + (attrs ? ' ' + attrs : ''));
        if (n.nodeName === 'TEMPLATE' && n.content) walk(n.content);
        else walk(n);
        parts.push('</' + n.nodeName + '>');
      } else if (n.nodeType === 8) {
        parts.push('<!--' + n.data + '-->');
      } else if (n.nodeType === 10) {
        parts.push('<!doctype ' + n.name + '|' + n.publicId + '|' + n.systemId + '>');
      }
    }
  })(doc);
  return parts.join('');
}

// Text we deliberately never offer for editing: code, metadata and inert
// content. Anything outside this and non-whitespace must be editable.
function isInCode(node) {
  for (let p = node.parentNode; p; p = p.parentNode) {
    if (p.nodeType === 11) return true;                     // <template> content
    const tag = (p.tagName || '').toUpperCase();
    if (QuickEditMap.BLOCKED.indexOf(tag) !== -1) return true;
  }
  return false;
}

function textsOf(doc) {
  return QuickEditMap.collectTextNodes(doc).map((n) => n.data);
}

function loadFixture(name) {
  const url = new URL('fixtures/' + name, location.href).href;
  return fetch(url).then((r) => {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.text();
  }).then((source) => new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.onload = () => resolve({ name, url, source, doc: frame.contentDocument, frame });
    frame.onerror = () => reject(new Error('iframe failed for ' + name));
    frame.src = url;
    document.getElementById('frames').appendChild(frame);
  }));
}

/*
 * Edit every editable text node in `doc` and return both the rewritten source
 * and the exact text-node list the rewritten source should parse back into.
 */
function editEverything(source, doc, transform) {
  const map = QuickEditMap.build(source, doc);
  const edits = [];
  const expected = map.records.map((r) => {
    if (!r.editable) return r.node.data;
    const next = transform(r.node.data);
    edits.push({
      start: r.span.start,
      end: r.span.end,
      replacement: QuickEditSplice.replacementFor(r.span, next),
    });
    return next;
  });
  return { map, edits, expected, edited: QuickEditSplice.applyEdits(source, edits) };
}

const arraysEqualAt = (a, b) => {
  if (a.length !== b.length) return 'length ' + a.length + ' vs ' + b.length;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return 'index ' + i + ': ' + JSON.stringify(a[i]) + ' vs ' + JSON.stringify(b[i]);
    }
  }
  return null;
};

// --- checks run against every fixture --------------------------------------

function commonChecks(fx) {
  const { name, source, doc } = fx;

  // 1. The tokenizer's spans are self-consistent and strictly ordered.
  const spans = QuickEditTokenizer.tokenize(source);
  let consistent = true, ordered = true, prevEnd = 0;
  for (const s of spans) {
    if (source.slice(s.start, s.end) !== s.raw) consistent = false;
    if (s.start < prevEnd || s.end < s.start) ordered = false;
    prevEnd = s.end;
  }
  ok(consistent, 'source spans quote the source exactly');
  ok(ordered, 'source spans are ordered and non-overlapping');

  // 2. Every text node in the real DOM is accounted for: either mapped to a
  //    source span, or positively identified as a parser-merged run.
  const map = QuickEditMap.build(source, doc);
  const unexplained = map.records.filter((r) => !r.span && r.reason !== 'merged-spans');
  ok(unexplained.length === 0,
     'every DOM text node is accounted for in the source',
     unexplained.length + ' unexplained, first: ' +
       JSON.stringify((unexplained[0] || {}).node && unexplained[0].node.data.slice(0, 60)));

  // 2b. Merged runs are allowed to exist but must never be editable, and in
  //     these fixtures they are only ever trailing whitespace.
  const merged = map.records.filter((r) => r.reason === 'merged-spans');
  ok(merged.every((r) => !r.editable && !/\S/.test(r.node.data)),
     'parser-merged text nodes are whitespace and are not editable',
     merged.length + ' merged');

  // 2c. Coverage: anything the user can actually see and would want to change
  //     must be editable. This is the claim that makes the extension useful.
  const shouldBeEditable = map.records.filter(
    (r) => /\S/.test(r.node.data) && !isInCode(r.node));
  const missed = shouldBeEditable.filter((r) => !r.editable);
  ok(missed.length === 0,
     'every visible run of text is editable (' + shouldBeEditable.length + ' regions)',
     missed.length + ' missed, first: ' +
       JSON.stringify((missed[0] || {}).node && missed[0].node.data.slice(0, 60)) +
       ' (' + (missed[0] || {}).reason + ')');

  // 3. Each pair round-trips: source bytes, decoded the way the parser decodes,
  //    equal the text the browser actually put in the DOM.
  const bad = map.records.filter(
    (r) => r.span && QuickEditMap.expectedText(r.span) !== r.node.data);
  ok(bad.length === 0, 'every mapped span decodes to its node text',
     bad.length + ' mismatched');

  // 4. THE core guarantee: no edits means no change, byte for byte.
  eq(QuickEditSplice.applyEdits(source, []), source,
     'a file with no edits is byte-identical');

  // 5. Edit every editable region, including characters that must be escaped,
  //    and check that only the text moved.
  const marker = ' <edited & "checked"  >';
  const res = editEverything(source, parse(source), (t) => t + marker);
  const before = parse(source);
  const after = parse(res.edited);

  eq(signature(after), signature(before),
     'editing all text leaves tags, attributes, comments and doctype untouched');

  const diff = arraysEqualAt(textsOf(after), res.expected);
  ok(diff === null, 'edited text parses back exactly as typed, nothing else moved', diff);

  ok(res.edits.length > 0, 'the fixture has at least one editable region');

  return { map, spans, res };
}

// --- fixture-specific checks ------------------------------------------------

function editOne(source, doc, predicate, transform) {
  const map = QuickEditMap.build(source, doc);
  const target = map.records.find((r) => r.editable && predicate(r.node.data));
  if (!target) return null;
  const replacement = QuickEditSplice.replacementFor(target.span, transform(target.node.data));
  return {
    target,
    edited: QuickEditSplice.applyEdits(source, [
      { start: target.span.start, end: target.span.end, replacement },
    ]),
  };
}

const SPECIFIC = {
  'nested-inline.html'(fx) {
    const r = editOne(fx.source, parse(fx.source),
                      (t) => t === ' world', () => ' planet');
    ok(!!r, 'found the " world" text node');
    if (!r) return;
    ok(r.edited.indexOf('<strong>bold <em>and italic</em></strong>') !== -1,
       'nested inline tags survive an edit to the text beside them');
    ok(r.edited.indexOf('<p>Hello <strong>bold <em>and italic</em></strong> planet</p>') !== -1,
       'only the targeted word changed');
  },

  'entities.html'(fx) {
    const before = fx.source;
    const r = editOne(before, parse(before),
                      (t) => t.indexOf('no entities') !== -1,
                      (t) => t.replace('no entities', 'NO ENTITIES'));
    ok(!!r, 'found the entity-free paragraph');
    if (!r) return;
    for (const frag of ['Smith&nbsp;&amp;&nbsp;Sons', '5 &lt; 6 and 9 &gt; 2',
                        '&#39;quoted&#39;', '&quot;double&quot;', '&#x2014; dash',
                        'Caf&eacute; na&iuml;ve &copy; 2026 &mdash; &frac12;']) {
      ok(r.edited.indexOf(frag) !== -1,
         'entity run survives an unrelated edit byte-identically: ' + frag);
    }
    // And the flip side: entities inside an edited span are re-encoded, not lost.
    const r2 = editOne(before, parse(before),
                       (t) => t.indexOf('R&D') !== -1, (t) => t.replace('R&D', 'R&D&D'));
    ok(!!r2 && r2.edited.indexOf('R&amp;D&amp;D') !== -1,
       'a typed ampersand is written back encoded');
  },

  'comments-doctype.html'(fx) {
    const r = editOne(fx.source, parse(fx.source),
                      (t) => t === 'Visible paragraph one.', () => 'Edited paragraph one.');
    ok(!!r, 'found a paragraph to edit');
    if (!r) return;
    const comments = fx.source.match(/<!--[\s\S]*?-->/g) || [];
    ok(comments.length >= 4, 'fixture actually contains comments (' + comments.length + ')');
    let kept = 0;
    for (const c of comments) if (r.edited.indexOf(c) !== -1) kept++;
    eq(kept, comments.length, 'every comment survives byte-identically');
    ok(r.edited.startsWith('<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN"'),
       'the doctype is untouched');
    ok(r.edited.indexOf('<![if !IE]>') !== -1, 'downlevel-revealed comment is untouched');
  },

  'messy.html'(fx) {
    const map = QuickEditMap.build(fx.source, fx.doc);
    const texts = map.records.filter((r) => r.editable).map((r) => r.node.data.trim());
    ok(texts.some((t) => t.indexOf('First paragraph') === 0),
       'text in an unclosed <P> is editable');
    ok(texts.some((t) => t === 'Uppercase tags'), 'text inside uppercase tags is editable');
    const maths = map.records.find((r) => r.editable && r.node.data.indexOf('Maths in text') !== -1);
    ok(!!maths, 'found the bare-angle-bracket paragraph');
    if (maths) {
      ok(maths.node.data.indexOf('5 < 6 and 7 > 6') !== -1,
         'a bare "<" in running text is treated as text, not markup');
      const edited = QuickEditSplice.applyEdits(fx.source, [{
        start: maths.span.start, end: maths.span.end,
        replacement: QuickEditSplice.replacementFor(maths.span, maths.node.data),
      }]);
      ok(edited.indexOf("alt='A cat, sitting > lying'") !== -1,
         'a ">" inside a single-quoted attribute does not end the tag');
      ok(edited.indexOf('5 &lt; 6 and 7 &gt; 6') !== -1,
         'bare angle brackets are encoded on write-back');
    }
  },

  'scripty.html'(fx) {
    const map = QuickEditMap.build(fx.source, fx.doc);
    const editableInCode = map.records.filter((r) => {
      if (!r.editable) return false;
      for (let p = r.node.parentNode; p; p = p.parentNode) {
        const tag = (p.tagName || '').toUpperCase();
        if (tag === 'SCRIPT' || tag === 'STYLE') return true;
      }
      return false;
    });
    eq(editableInCode.length, 0, 'nothing inside <script> or <style> is editable');

    const html = map.records.filter(
      (r) => r.editable && r.node.data.indexOf('string literal') !== -1);
    eq(html.length, 0, 'HTML-looking string literals in a script are not editable');

    const r = editOne(fx.source, parse(fx.source),
                      (t) => t.indexOf('Editable paragraph between') !== -1,
                      () => 'Edited paragraph between the script blocks.');
    ok(!!r, 'found an editable paragraph beside the script');
    if (r) {
      const script = fx.source.slice(fx.source.indexOf('<script>'),
                                     fx.source.indexOf('</script>') + 9);
      ok(r.edited.indexOf(script) !== -1, 'script contents survive byte-identically');
      ok(r.edited.indexOf('content: "\\003C /style> is not really here";') !== -1,
         'style contents survive byte-identically');
    }
  },

  'pre-template.html'(fx) {
    const map = QuickEditMap.build(fx.source, fx.doc);
    const inTemplate = map.records.filter(
      (r) => r.editable && r.node.data.indexOf('Template text') !== -1);
    eq(inTemplate.length, 0, '<template> content is mapped but not editable');

    const inNoscript = map.records.filter(
      (r) => r.editable && r.node.data.indexOf('Noscript content') !== -1);
    eq(inNoscript.length, 0, '<noscript> content is not editable');

    const inTextarea = map.records.filter(
      (r) => r.editable && r.node.data.indexOf('Textarea content') !== -1);
    eq(inTextarea.length, 0, '<textarea> content is not editable');

    const pre = map.records.find(
      (r) => r.editable && r.node.data.indexOf('first line of preformatted') !== -1);
    ok(!!pre, 'found the <pre> text');
    if (pre) {
      ok(pre.node.data.charAt(0) === 'f',
         'the newline the parser eats after <pre> is not part of the node text');
      eq(fx.source.charAt(pre.span.start - 1), '\n',
         'that eaten newline sits just outside the mapped span');
      const edited = QuickEditSplice.applyEdits(fx.source, [{
        start: pre.span.start, end: pre.span.end,
        replacement: QuickEditSplice.replacementFor(pre.span, 'FIRST line of preformatted text\n  indented second line\nlast line'),
      }]);
      ok(edited.indexOf('<pre>\nFIRST line') !== -1,
         'editing a <pre> keeps the eaten newline in the file');
    }
  },

  'crlf.html'(fx) {
    ok(fx.source.indexOf('\r\n') !== -1, 'fixture really uses CRLF');
    const r = editOne(fx.source, parse(fx.source),
                      (t) => t.indexOf('Costs were flat') !== -1,
                      (t) => t.replace('flat', 'down slightly'));
    ok(!!r, 'found a paragraph in the CRLF file');
    if (r) {
      const crlfBefore = (fx.source.match(/\r\n/g) || []).length;
      const crlfAfter = (r.edited.match(/\r\n/g) || []).length;
      eq(crlfAfter, crlfBefore, 'CRLF line endings are all still there after an edit');
      ok(r.edited.indexOf('\n\n') === -1 || fx.source.indexOf('\n\n') !== -1,
         'no bare LF was introduced');
    }
  },

  'large.html'(fx) {
    const t0 = performance.now();
    const map = QuickEditMap.build(fx.source, fx.doc);
    const buildMs = performance.now() - t0;

    // Saving is the other half of "stays responsive": splice every region at once.
    const t1 = performance.now();
    const all = map.records.filter((r) => r.editable).map((r) => ({
      start: r.span.start, end: r.span.end,
      replacement: QuickEditSplice.replacementFor(r.span, r.node.data + '.'),
    }));
    const edited = QuickEditSplice.applyEdits(fx.source, all);
    const spliceMs = performance.now() - t1;

    line('pass', '        (' + fx.source.length.toLocaleString() + ' chars, ' +
         map.stats.nodes.toLocaleString() + ' text nodes, ' +
         map.stats.editable.toLocaleString() + ' editable — map ' +
         buildMs.toFixed(1) + 'ms, splice of all ' + all.length.toLocaleString() +
         ' regions ' + spliceMs.toFixed(1) + 'ms)');

    // Headless Chrome is usually driven with --virtual-time-budget, which stops
    // the clock during synchronous script execution: every measurement comes
    // back as exactly 0. Rather than report a meaningless pass, say so — the
    // wall-clock numbers come from `node test/node-test.js` instead.
    if (buildMs === 0 && spliceMs === 0) {
      line('head', '        (clock is virtualised — timing assertions skipped here;' +
                   ' see the node benchmark for wall-clock figures)');
    } else {
      ok(buildMs < 3000, 'a ~1MB file maps in under 3s', buildMs.toFixed(1) + 'ms');
      ok(spliceMs < 1000, 'splicing every region of a ~1MB file takes under 1s',
         spliceMs.toFixed(1) + 'ms');
    }
    ok(edited.length > fx.source.length, 'the mass edit actually changed the file');

    // Every node is either mapped or a positively identified merged run;
    // nothing is left unexplained.
    const mergedCount = map.records.filter((r) => r.reason === 'merged-spans').length;
    eq(map.stats.mapped + mergedCount, map.stats.nodes,
       'every node in the large file is mapped or explained');
    ok(map.stats.editable > 5000, 'the large file has plenty of editable regions',
       String(map.stats.editable));
  },
};

// --- islands and write-back -------------------------------------------------

/*
 * The islands are wrappers injected into the live DOM. They can never reach the
 * saved file, but they can disturb the page the user is looking at, so the
 * claim to test is that putting them in and taking them out again leaves the
 * document exactly as it was.
 */
async function islandChecks() {
  const BR = QuickEditIslands.BR;

  heading('islands — DOM mechanics');
  {
    const box = document.createElement('div');
    box.hidden = true;
    box.innerHTML = '<p>Hello <strong>bold <em>and italic</em></strong> world</p>' +
                    '<p>Adjacent<span>runs</span>with<span>none</span></p>';
    document.body.appendChild(box);

    const before = box.innerHTML;
    const islands = QuickEditMap.collectTextNodes(box).map((n) => QuickEditIslands.wrap(n));
    ok(box.innerHTML !== before, 'wrapping does change the live DOM');
    ok(box.querySelectorAll('[data-qe-island]').length === islands.length,
       'every text node got its own island');

    islands.forEach(QuickEditIslands.unwrap);
    eq(box.innerHTML, before, 'unwrapping restores the live DOM exactly');
    box.remove();
  }

  heading('islands — values');
  {
    const el = document.createElement('span');
    document.body.appendChild(el);

    QuickEditIslands.writeValue(el, 'one' + BR + 'two');
    eq(el.innerHTML, 'one<br>two', 'a line break in a value is a <br> in the DOM');
    eq(QuickEditIslands.readValue(el), 'one' + BR + 'two', 'and reads back as it was written');

    QuickEditIslands.writeValue(el, '');
    eq(el.childNodes.length, 0, 'an emptied island really is empty');
    eq(QuickEditIslands.readValue(el), '', 'and reads back as empty');

    QuickEditIslands.writeValue(el, 'a' + BR + BR + 'b');
    eq(QuickEditIslands.readValue(el), 'a' + BR + BR + 'b', 'consecutive breaks survive');

    // A stray element (a paste that got past the interceptor) keeps its words.
    el.appendChild(document.createElement('b')).textContent = 'pasted';
    eq(QuickEditIslands.readValue(el), 'a' + BR + BR + 'bpasted',
       'a stray element is read as its text, so nothing is lost');
    ok(!QuickEditIslands.isClean(el), 'and is reported as needing flattening');

    QuickEditIslands.writeValue(el, QuickEditIslands.readValue(el));
    ok(QuickEditIslands.isClean(el), 'flattening removes the element but keeps the words');

    QuickEditIslands.writeValue(el, 'abcdef');
    QuickEditIslands.setCaret(el, 3);
    eq(QuickEditIslands.caretIndex(el), 3, 'the caret index round-trips through text');

    QuickEditIslands.writeValue(el, 'ab' + BR + 'cd');
    QuickEditIslands.setCaret(el, 4);
    eq(QuickEditIslands.caretIndex(el), 4, 'the caret index round-trips across a <br>');
    el.remove();
  }

  heading('islands — a whole document, wrapped and unwrapped');
  {
    const fx = await loadFixture('nested-inline.html');
    const map = QuickEditMap.build(fx.source, fx.doc);
    const before = fx.doc.documentElement.outerHTML;

    const islands = map.records
      .filter((r) => r.editable)
      .map((r) => QuickEditIslands.wrap(r.node));
    ok(islands.length > 0, 'the fixture produced islands (' + islands.length + ')');

    islands.forEach(QuickEditIslands.unwrap);
    eq(fx.doc.documentElement.outerHTML, before,
       'turning edit mode on and off with no changes leaves the document untouched');
  }

  heading('write-back — a single edit in a real file');
  {
    const fx = await loadFixture('nested-inline.html');
    const map = QuickEditMap.build(fx.source, parse(fx.source));
    const target = map.records.find((r) => r.editable && r.node.data === ' world');
    ok(!!target, 'found the " world" region');
    if (target) {
      const value = ' pla' + BR + 'net';
      const edited = QuickEditSplice.applyEdits(fx.source, [{
        start: target.span.start,
        end: target.span.end,
        replacement: QuickEditEditor.serialise(value, target.span),
      }]);

      ok(edited.indexOf('<p>Hello <strong>bold <em>and italic</em></strong> pla<br>net</p>') !== -1,
         'the <br> lands inside the edited region and the tags beside it do not move');

      // The bytes on either side of the edited range are the original bytes.
      eq(edited.slice(0, target.span.start), fx.source.slice(0, target.span.start),
         'everything before the edit is byte-identical');
      eq(edited.slice(edited.length - (fx.source.length - target.span.end)),
         fx.source.slice(target.span.end),
         'everything after the edit is byte-identical');

      const brBefore = parse(fx.source).querySelectorAll('br').length;
      const brAfter = parse(edited).querySelectorAll('br').length;
      eq(brAfter, brBefore + 1, 'exactly one <br> was added to the whole document');
    }
  }
}

// --- run --------------------------------------------------------------------

async function run() {
  for (const name of FIXTURES) {
    heading(name);
    try {
      const fx = await loadFixture(name);
      commonChecks(fx);
      if (SPECIFIC[name]) SPECIFIC[name](fx);
    } catch (err) {
      tally.fail++;
      line('fail', '  FAIL  could not run fixture — ' + (err && err.message || err));
    }
  }

  try {
    await islandChecks();
  } catch (err) {
    tally.fail++;
    line('fail', '  FAIL  island checks — ' + (err && err.message || err));
  }

  Report.finish();
}

run();
