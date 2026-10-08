/*
 * VibeRevise — the file changed underneath us. Pure functions, no DOM.
 *   node src/lib/rebase.test.js
 */
'use strict';
const R = require('./rebase.js');

let pass = 0, fail = 0;
const ok = (c, n, d) => c ? (pass++, console.log('  PASS  ' + n))
                          : (fail++, console.log('  FAIL  ' + n + (d ? ' — ' + d : '')));
const eq = (a, b, n) => ok(JSON.stringify(a) === JSON.stringify(b), n,
                           'got ' + JSON.stringify(a) + ', wanted ' + JSON.stringify(b));
const section = (t) => console.log('\n' + t);

const A = [
  '<h1>Plan</h1>',
  '<p>First paragraph, untouched.</p>',
  '<p>Second paragraph, which the other tool rewrites.</p>',
  '<p>Third paragraph, also untouched.</p>',
  '',
].join('\n');
const B = [
  '<h1>Plan</h1>',
  '<p>A new paragraph the other tool added.</p>',
  '<p>First paragraph, untouched.</p>',
  '<p>Second paragraph, rewritten by someone else entirely.</p>',
  '<p>Third paragraph, also untouched.</p>',
  '',
].join('\n');

section('which parts are unchanged');
{
  const d = R.diff(A, B);
  const first = A.indexOf('First paragraph');
  const m = R.mapRange(d, first, first + 'First paragraph'.length);
  ok(m && B.slice(m.start, m.end) === 'First paragraph', 'an untouched paragraph is found again, though it moved');
  const third = A.indexOf('Third paragraph');
  const m3 = R.mapRange(d, third, third + 5);
  ok(m3 && B.slice(m3.start, m3.end) === 'Third', 'and so is one after the change');
  const second = A.indexOf('Second paragraph');
  eq(R.mapRange(d, second, second + 6), null, 'a rewritten one is not');
  const h = R.hunkAt(d, second);
  ok(h && /rewritten by someone else/.test(B.slice(h.bStart, h.bEnd)), 'its replacement is where the change says');

  const afterFirst = A.indexOf('</p>', first) + 4;
  const p = R.mapPoint(d, afterFirst);
  eq(B.slice(p - 4, p), '</p>', 'a point just after an unchanged closing tag maps to just after it');

  // Together the pieces cover both texts exactly.
  const pieces = d.equal.concat(d.hunks).sort((x, y) => x.aStart - y.aStart);
  eq(pieces.map((x) => A.slice(x.aStart, x.aEnd)).join(''), A, 'the pieces cover the old text');
  eq(pieces.sort((x, y) => x.bStart - y.bStart).map((x) => B.slice(x.bStart, x.bEnd)).join(''), B, 'and the new');
}

section('the edges');
{
  const same = R.diff(A, A);
  ok(same.same && same.hunks.length === 0, 'the same text has no changes');
  eq(R.mapRange(same, 3, 7), { start: 3, end: 7 }, 'and maps to itself');
  const none = R.diff(A, A + '<p>Appended.</p>');
  eq(none.hunks.length, 1, 'something added at the end is one change');
  const crlf = R.diff('a\r\nb\r\nc', 'a\r\nB\r\nc');
  eq(crlf.hunks.length, 1, 'Windows line endings are lines too');
  eq(R.diff('', 'x').hunks.length, 1, 'from nothing');
}

section('carrying our own saved edits onto the review point');
{
  // base: what was last reviewed. from -> to: our save. The other tool's
  // change (in base's future) is not involved.
  const from = A;
  const to = A.replace('Third paragraph, also untouched.', 'Third paragraph, edited by us.');
  eq(R.transplant(from, from, to), to, 'with nothing outstanding, the review point is simply what was saved');
  const base = A.replace('First paragraph, untouched.', 'First paragraph, as reviewed earlier.');
  const moved = R.transplant(base, from, to);
  ok(moved.indexOf('edited by us') !== -1, 'our edit is carried across');
  ok(moved.indexOf('as reviewed earlier') !== -1, 'and the rest of the review point is left alone');
}

section('readable text, and likeness');
{
  eq(R.textOf('<p class="x">Smith&nbsp;&amp;&nbsp;Sons <b>rose</b> 5&#37;</p><!-- note -->'), 'Smith & Sons rose 5%',
     'tags, comments and entities are reduced to the words');
  ok(R.similarity('Revenue grew by 12% over the quarter', 'Revenue grew 12% this quarter') > 0.4, 'a reworded sentence is alike');
  ok(R.similarity('Revenue grew by 12%', 'Staff turnover fell') < 0.2, 'an unrelated one is not');
}

console.log('\n' + (fail ? 'FAILED' : 'ALL PASS') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
