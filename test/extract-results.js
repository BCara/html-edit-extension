/*
 * Pulls the readable test results out of Chrome's --dump-dom output.
 * (The result lines are inside <span> elements whose text contains newlines,
 * so line-based tools such as sed cannot pick them apart.)
 */
'use strict';
const fs = require('fs');

const dom = fs.readFileSync(process.argv[2], 'utf8');
const unescape = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

let verdict = '';
let failLines = 0;
const re = /<span class="(pass|fail|head)">([\s\S]*?)<\/span>/g;
let m;
while ((m = re.exec(dom)) !== null) {
  const text = unescape(m[2]).replace(/\n+$/, '');
  if (m[1] === 'fail') failLines++;
  if (m[1] === 'head') console.log('\n' + text);
  else console.log(text);
}
const v = /QE-RESULT: [^<]*/.exec(dom);
if (v) verdict = v[0];
// No verdict means the page never finished: it failed to load, or crashed
// before reporting. Say which page, since "non-zero" alone looks the same as
// a failed assertion from run.sh's side.
if (!verdict) {
  console.log('\nNO RESULT from ' + (process.argv[3] || process.argv[2]) +
              ' — the page never reported. It failed to load, or stopped before finishing' +
              (failLines ? ' (' + failLines + ' FAIL line(s) were written first).' : '.'));
  process.exit(2);
}
console.log('\n' + verdict);

/*
 * The verdict line is the page's own summary, and a page can be wrong about
 * itself: a crash handler that writes FAIL onto the page without counting it
 * produces a red line above "ALL PASS — 0 failed", and a suite that died
 * halfway reports green. That happened. So the page's word is not taken on
 * its own: any FAIL line at all fails the run, whatever the summary says.
 */
if (failLines > 0 && /ALL PASS/.test(verdict)) {
  console.log('\nCONTRADICTION: ' + failLines + ' FAIL line(s) above a verdict of ALL PASS — ' +
              'something failed without being counted. Treating the run as failed.');
  process.exit(1);
}
process.exit(/ALL PASS/.test(verdict) && failLines === 0 ? 0 : 1);
