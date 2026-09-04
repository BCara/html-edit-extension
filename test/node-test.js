/*
 * Quick Edit — tokenizer and splice unit tests.
 *
 * These cover the parts that need no DOM, so they run instantly in node and
 * pin down the fiddly offset arithmetic on its own. The claims that involve the
 * real HTML parser live in harness.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

for (const f of ['lib/tokenizer.js', 'lib/splice.js', 'lib/islands.js', 'editor.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), { filename: f });
}
const { tokenize } = globalThis.QuickEditTokenizer;
const { escapeText, applyEdits, replacementFor } = globalThis.QuickEditSplice;
const { BR } = globalThis.QuickEditIslands;
const { serialise } = globalThis.QuickEditEditor;

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
// Every span must quote the source at its own offsets.
function selfConsistent(src) {
  return tokenize(src).every((s) => src.slice(s.start, s.end) === s.raw);
}

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
  ok(selfConsistent(src), 'spans quote the source: ' + JSON.stringify(src.slice(0, 40)));
}
{
  // Non-ASCII must not shift offsets: JS string offsets are UTF-16 code units
  // and both sides of the map use the same string, so this has to hold exactly.
  const src = '<p>café</p><p>🚀 rocket</p>';
  const spans = tokenize(src);
  eq(src.slice(spans[0].start, spans[0].end), 'café', 'accented text offsets');
  eq(src.slice(spans[1].start, spans[1].end), '🚀 rocket', 'astral-plane text offsets');
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

section('splice — against the real fixtures');
{
  const dir = path.join(__dirname, 'fixtures');
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.html'))) {
    const src = fs.readFileSync(path.join(dir, name), 'utf8');
    ok(applyEdits(src, []) === src, name + ': no edits is byte-identical');
    ok(selfConsistent(src), name + ': every span quotes the source exactly');
    // Rewriting every span with its own raw text must reproduce the file exactly.
    const same = applyEdits(src, tokenize(src).map(
      (s) => ({ start: s.start, end: s.end, replacement: s.raw })));
    ok(same === src, name + ': rewriting every span with its own bytes is a no-op');
  }
}

section('write-back — island values become source text');
{
  const lf = { raw: 'x' };
  const crlf = { raw: 'a\r\nb' };

  eq(serialise('just words', lf), 'just words', 'plain text passes straight through');
  eq(serialise('Smith & Sons', lf), 'Smith &amp; Sons', 'a typed ampersand is encoded');
  eq(serialise('5 < 6 > 2', lf), '5 &lt; 6 &gt; 2', 'typed angle brackets are encoded');

  // Enter is the one thing that can add markup, and this is where it happens.
  eq(serialise('one' + BR + 'two', lf), 'one<br>two', 'a line break becomes a <br>');
  eq(serialise('a' + BR + BR + 'b', lf), 'a<br><br>b', 'consecutive line breaks');
  eq(serialise(BR + 'leading', lf), '<br>leading', 'a leading line break');
  eq(serialise('trailing' + BR, lf), 'trailing<br>', 'a trailing line break');
  eq(serialise('a < b' + BR + 'c & d', lf), 'a &lt; b<br>c &amp; d',
     'escaping and line breaks together');

  eq(serialise('', lf), '', 'an emptied region writes nothing at all');
  eq(serialise('multi\nline', crlf), 'multi\r\nline',
     'existing newlines keep the file\'s CRLF style');
  eq(serialise('a' + BR + 'b', crlf), 'a<br>b',
     'a <br> is a tag, not a line ending, so CRLF does not apply to it');
}

section('performance — wall clock, on the ~1MB fixture');
{
  const big = path.join(__dirname, 'fixtures', 'large.html');
  if (!fs.existsSync(big)) {
    console.log('  SKIP  large.html not generated yet (run node test/make-large.js)');
  } else {
    const src = fs.readFileSync(big, 'utf8');

    let t = process.hrtime.bigint();
    const spans = tokenize(src);
    const tokenizeMs = Number(process.hrtime.bigint() - t) / 1e6;

    // Worst case for saving: every single region rewritten at once.
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
