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
const re = /<span class="(pass|fail|head)">([\s\S]*?)<\/span>/g;
let m;
while ((m = re.exec(dom)) !== null) {
  const text = unescape(m[2]).replace(/\n+$/, '');
  if (m[1] === 'head') console.log('\n' + text);
  else console.log(text);
}
const v = /QE-RESULT: [^<]*/.exec(dom);
if (v) verdict = v[0];
if (!verdict) process.exit(2);
console.log('\n' + verdict);
process.exit(/ALL PASS/.test(verdict) ? 0 : 1);
