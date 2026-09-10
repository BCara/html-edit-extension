/*
 * html-text-splice — test suite.
 *
 * Everything here runs in plain node against the published entry point, so it
 * is also the worked example: if you are evaluating this library, this file is
 * the fastest way to see what it promises and what it refuses to do.
 *
 *   node test/engine-test.js
 *
 * The two guarantees the whole library exists to make are pinned in
 * "byte preservation" at the bottom, against real files.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {
  scan, tokenize, applyEdits, escapeText, replacementFor, replaceSpans, verify,
} = require('../index.js');

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}
function eq(actual, expected, name) {
  ok(actual === expected, name,
     'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}
function deq(actual, expected, name) {
  eq(JSON.stringify(actual), JSON.stringify(expected), name);
}
function section(t) { console.log('\n' + t); }

// Compact view of a tokenization: the raw text of each span.
const raws = (src) => tokenize(src).map((s) => s.raw);

section('tokenizer — basics');
deq(raws('<p>Hello</p>'), ['Hello'], 'simple element text');
deq(raws('<p>Hello <b>there</b> you</p>'), ['Hello ', 'there', ' you'],
    'text is split by inline tags');
deq(raws('a<!--c-->b'), ['a', 'b'], 'a comment splits text and is itself skipped');
deq(raws('<!DOCTYPE html><p>x</p>'), ['x'], 'the doctype produces no span');
deq(raws('<p>a</p><!-- <p>not text</p> -->'), ['a'], 'markup inside a comment is skipped');
deq(raws('<!--- weird --><p>a</p>'), ['a'], 'a comment with extra dashes');
deq(raws('<![if !IE]><p>a</p><![endif]>'), ['a'], 'downlevel-revealed comments are skipped');
deq(raws('<p>a</p><?php echo "b"; ?><p>c</p>'), ['a', 'c'], 'processing instructions are skipped');

section('tokenizer — bare angle brackets');
deq(raws('<p>5 < 6 and 7 > 6</p>'), ['5 < 6 and 7 > 6'],
    'a "<" followed by a space is text');
deq(raws('<p>a<b lives here</p>'), ['a'], 'a "<" followed by a letter starts a tag');

section('tokenizer — attributes');
deq(raws("<img alt='a > b'>text"), ['text'], "a '>' inside single quotes does not end the tag");
deq(raws('<img alt="a > b">text'), ['text'], 'a ">" inside double quotes does not end the tag');
deq(raws('<div id=main class = "wide">text</div>'), ['text'],
    'unquoted values and spaces around "=" are handled');
deq(raws('<a href=/x?a=1>text</a>'), ['text'], 'an unquoted value ends at ">"');
deq(raws('<br/>text'), ['text'], 'a self-closing tag');

section('tokenizer — raw text and RCDATA');
deq(raws('<script>var s = "<p>x</p>";</script><p>y</p>'),
    ['var s = "<p>x</p>";', 'y'],
    'markup inside a script is one raw span, not parsed');
deq(raws('<script>if (a </b> b) {}</script>'), ['if (a </b> b) {}'],
    'a non-matching end tag does not close a script');
// A "</style>" inside a CSS string really does close the element — the parser
// tokenizes raw text without understanding CSS, and so do we.
deq(raws('<style>.a{content:"</style>"}</style>'),
    ['.a{content:"', '"}'],
    'a </style> inside a CSS string closes the element, as the parser has it');
deq(raws('<script>var s = "</scr" + "ipt>";</script>'),
    ['var s = "</scr" + "ipt>";'],
    'a split end tag in a script string does not close it');
deq(raws('<title>A &amp; B</title><p>c</p>'), ['A &amp; B', 'c'],
    'title content is a single RCDATA span');
eq(tokenize('<script>x</script>')[0].kind, 'rawtext', 'script spans are marked raw text');
eq(tokenize('<title>x</title>')[0].kind, 'rcdata', 'title spans are marked RCDATA');
eq(tokenize('<p>x</p>')[0].kind, 'text', 'ordinary spans are marked text');

section('tokenizer — the newline <pre> eats');
{
  const src = '<pre>\nkeep me</pre>';
  const [span] = tokenize(src);
  eq(span.raw, 'keep me', 'the eaten newline is outside the span');
  eq(span.eaten, '\n', 'and is recorded');
  eq(src.charAt(span.start - 1), '\n', 'the newline itself stays put in the source');
  eq(tokenize('<pre>only</pre>')[0].eaten, '', 'no newline, nothing eaten');
  deq(raws('<pre>\n</pre>'), [], 'a <pre> containing only the eaten newline yields no span');
  eq(tokenize('<pre>\r\nx</pre>')[0].eaten, '\r\n', 'a CRLF is eaten whole');
}

section('tokenizer — offsets are exact');
for (const src of [
  '<p>a</p>',
  '<!doctype html><HTML><BODY CLASS=\'x>y\'><P>one<P>two</BODY></HTML>',
  '<div>éà你好 🚀 emoji and accents</div>',
  '<p>&amp;&nbsp;&lt;</p><script>a<b</script><pre>\nx</pre>',
]) {
  ok(verify(src), 'spans quote the source: ' + JSON.stringify(src.slice(0, 40)));
}
{
  // Non-ASCII must not shift offsets: JS string offsets are UTF-16 code units
  // and both sides of the map use the same string, so this has to hold exactly.
  const src = '<p>café</p><p>🚀 rocket</p>';
  const spans = tokenize(src);
  eq(src.slice(spans[0].start, spans[0].end), 'café', 'accented text offsets');
  eq(src.slice(spans[1].start, spans[1].end), '🚀 rocket', 'astral-plane text offsets');
}

section('scan — tags and comments, for callers pairing spans with a real tree');
{
  const { spans, tags, comments } = scan('<div><p>a</p><!--note--></div>');
  deq(spans.map((s) => s.raw), ['a'], 'one text span');
  deq(tags.map((t) => (t.isEnd ? '/' : '') + t.name), ['div', 'p', '/p', '/div'],
      'tags in source order, nothing inferred about nesting');
  eq(comments.length, 1, 'the comment is recorded');
  eq(comments[0].data, 'note', 'with its content');
  eq(comments[0].bogus, false, 'and marked as a real comment');
  eq(scan('<![if !IE]>x')[Symbol.iterator] === undefined, true, 'scan returns an object');
  eq(scan('<![if !IE]>x').comments[0].bogus, true, 'a downlevel construct is marked bogus');
}

section('escaping');
eq(escapeText('plain text'), 'plain text', 'ordinary text is left alone');
eq(escapeText('5 < 6 & 7 > 2'), '5 &lt; 6 &amp; 7 &gt; 2', 'angle brackets and ampersands');
eq(escapeText('&amp;'), '&amp;amp;', 'a literal "&amp;" typed by the user is escaped again');
eq(escapeText('a b'), 'a&nbsp;b', 'a non-breaking space is encoded');
eq(escapeText("it's \"quoted\""), 'it\'s "quoted"', 'quotes are left alone in text content');
eq(escapeText('café 🚀'), 'café 🚀', 'non-ASCII is written through as UTF-8');

section('escaping — line endings');
eq(replacementFor({ raw: 'a\nb' }, 'x\ny'), 'x\ny', 'an LF file stays LF');
eq(replacementFor({ raw: 'a\r\nb' }, 'x\ny'), 'x\r\ny', 'a CRLF file stays CRLF');
eq(replacementFor({ raw: 'a' }, 'x & y'), 'x &amp; y', 'escaping still applies');

section('splice');
eq(applyEdits('unchanged', []), 'unchanged', 'no edits returns the source unchanged');
eq(applyEdits('abcdef', [{ start: 2, end: 4, replacement: 'XY' }]), 'abXYef', 'one edit');
eq(applyEdits('abcdef', [
  { start: 4, end: 5, replacement: 'YY' },
  { start: 1, end: 2, replacement: 'X' },
]), 'aXcdYYf', 'edits given out of order are applied by offset');
eq(applyEdits('abcdef', [
  { start: 0, end: 1, replacement: 'LONGER' },
  { start: 5, end: 6, replacement: 'Z' },
]), 'LONGERbcdeZ', 'a length change early does not disturb a later offset');
eq(applyEdits('abcdef', [{ start: 3, end: 3, replacement: '!' }]), 'abc!def', 'an empty range inserts');

{
  let threw = false;
  try {
    applyEdits('abcdef', [
      { start: 0, end: 3, replacement: 'x' },
      { start: 2, end: 4, replacement: 'y' },
    ]);
  } catch (e) { threw = /overlapping/.test(e.message); }
  ok(threw, 'overlapping edits are refused, not guessed at');

  threw = false;
  try { applyEdits('abc', [{ start: 1, end: 99, replacement: 'x' }]); }
  catch (e) { threw = /out of bounds/.test(e.message); }
  ok(threw, 'an out-of-bounds range is refused');
}

section('replaceSpans — the high-level call');
{
  const src = '<p class=lead>Hello</p>\n<p>Goodbye</p>\n';
  const spans = tokenize(src);
  eq(replaceSpans(src, [{ span: spans[0], text: 'Good morning' }]),
     '<p class=lead>Good morning</p>\n<p>Goodbye</p>\n',
     'the unquoted attribute, the newlines and the untouched paragraph all survive');
  eq(replaceSpans(src, []), src, 'no changes is byte-identical');
  eq(replaceSpans(src, [{ span: spans[0], text: 'a < b & c' }]),
     '<p class=lead>a &lt; b &amp; c</p>\n<p>Goodbye</p>\n',
     'typed markup characters are escaped, not honoured');

  const crlf = '<p>one</p>\r\n<p>two</p>\r\n';
  const both = tokenize(crlf);
  eq(replaceSpans(crlf, [{ span: both[0], text: 'x' }]), '<p>x</p>\r\n<p>two</p>\r\n',
     'a CRLF document keeps its line endings');
}

section('byte preservation — against real files');
{
  const dir = path.join(__dirname, 'fixtures');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.html'));
  ok(files.length > 0, 'there are fixtures to check');
  for (const name of files) {
    const src = fs.readFileSync(path.join(dir, name), 'utf8');
    ok(applyEdits(src, []) === src, name + ': no edits is byte-identical');
    ok(verify(src), name + ': every span quotes the source exactly');
    // Rewriting every span with its own raw text must reproduce the file exactly.
    const same = applyEdits(src, tokenize(src).map(
      (s) => ({ start: s.start, end: s.end, replacement: s.raw })));
    ok(same === src, name + ': rewriting every span with its own bytes is a no-op');
  }
}

section('performance — wall clock, on a ~1MB document');
{
  const big = path.join(__dirname, 'fixtures', 'large.html');
  if (!fs.existsSync(big)) {
    console.log('  SKIP  large.html not generated yet (run node test/make-large.js)');
  } else {
    const src = fs.readFileSync(big, 'utf8');

    let t = process.hrtime.bigint();
    const spans = tokenize(src);
    const tokenizeMs = Number(process.hrtime.bigint() - t) / 1e6;

    // Worst case: every single region rewritten at once.
    const edits = spans.map((s) => ({ start: s.start, end: s.end, replacement: s.raw + '.' }));
    t = process.hrtime.bigint();
    const edited = applyEdits(src, edits);
    const spliceMs = Number(process.hrtime.bigint() - t) / 1e6;

    console.log('        ' + src.length.toLocaleString() + ' chars, ' +
                spans.length.toLocaleString() + ' spans — tokenize ' +
                tokenizeMs.toFixed(1) + 'ms, splice all ' + spliceMs.toFixed(1) + 'ms');
    ok(tokenizeMs < 1000, 'tokenizing ~1MB takes under 1s', tokenizeMs.toFixed(1) + 'ms');
    ok(spliceMs < 1000, 'splicing every span of ~1MB takes under 1s', spliceMs.toFixed(1) + 'ms');
    ok(edited.length === src.length + spans.length, 'the mass splice produced the expected length');
  }
}

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
