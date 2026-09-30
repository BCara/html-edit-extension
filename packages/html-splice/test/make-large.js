/*
 * Generates test/fixtures/large.html (~1MB) for the responsiveness check.
 * Not committed as a fixture because it is machine-generated; run:
 *   node test/make-large.js
 */
const fs = require('fs');
const path = require('path');

const out = [];
out.push('<!DOCTYPE html>');
out.push('<html lang="en">');
out.push('<head>');
out.push('<meta charset="utf-8">');
out.push('<title>Large document</title>');
out.push('<style>body { font: 15px/1.6 system-ui, sans-serif; } .row { margin: 1em 0; }</style>');
out.push('</head>');
out.push('<body>');
out.push('<h1>Large document</h1>');

let i = 0;
let size = 0;
while (size < 1000000) {
  i++;
  const block = [
    '<section class="row" id="s' + i + '">',
    '  <!-- block ' + i + ' -->',
    '  <h2>Section ' + i + '</h2>',
    '  <p>Paragraph ' + i + ' with <strong>bold text</strong> and <em>emphasis</em> plus an entity: Smith&nbsp;&amp;&nbsp;Sons.</p>',
    '  <p>A repeated line that is identical in every section, to exercise non-unique text.</p>',
    '  <ul><li>Item one</li><li>Item two</li><li>Item ' + i + '</li></ul>',
    '</section>',
  ].join('\n');
  out.push(block);
  size += block.length + 1;
}

out.push('</body>');
out.push('</html>');
out.push('');

const file = path.join(__dirname, 'fixtures', 'large.html');
const text = out.join('\n');
fs.writeFileSync(file, text);
console.log('wrote', file, text.length, 'chars,', i, 'sections');
