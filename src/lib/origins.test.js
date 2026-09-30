/*
 * Quick Edit — origins tests. Pure functions, no DOM.
 *   node src/lib/origins.test.js
 */
'use strict';
const O = require('./origins.js');

let pass = 0, fail = 0;
const ok = (c, n, d) => c ? (pass++, console.log('  PASS  ' + n))
                          : (fail++, console.log('  FAIL  ' + n + (d ? ' — ' + d : '')));
const section = (t) => console.log('\n' + t);
const headers = (o) => ({ get: (k) => {
  const hit = Object.keys(o).find((n) => n.toLowerCase() === k.toLowerCase());
  return hit ? o[hit] : null;
} });

section('classify — what Quick Edit will touch');
for (const [url, want] of [
  ['file:///home/c/a.html', 'file'],
  ['file:///home/c/a.txt', null],
  ['http://192.168.1.71:5000/nas-raw/projects/plan.html#market-position', 'lan'],
  ['http://localhost:8095/index.html', 'lan'],
  ['http://127.0.0.1:8080/a.htm', 'lan'],
  ['http://10.1.2.3/x.html', 'lan'],
  ['http://172.16.0.1/x.html', 'lan'],
  ['http://172.32.0.1/x.html', null],
  ['http://100.110.36.48:5000/x.html', 'lan'],
  ['https://nas.local/doc.html', 'lan'],
  ['https://example.com/a.html', null],
  ['http://192.168.1.71:5000/api/route', null],
  ['chrome://extensions', null],
  ['not a url at all', null],
]) {
  ok(O.classify(url).kind === want, (want || 'refused') + ': ' + url.slice(0, 62),
     'got ' + O.classify(url).kind);
}

section('acceptsWriteBack — Allow is a capability, CORS is a policy');
ok(O.acceptsWriteBack(headers({ Allow: 'GET, HEAD, OPTIONS, PUT' })),
   'Allow listing PUT is a yes');
ok(!O.acceptsWriteBack(headers({ Allow: 'GET, HEAD, OPTIONS' })),
   'Allow without PUT is a no');
// The regression. A stock `cors` middleware sends exactly this, and reading it
// as a capability made every static file server 404 on the first save.
ok(!O.acceptsWriteBack(headers({
     'Access-Control-Allow-Methods': 'GET,HEAD,PUT,PATCH,POST,DELETE',
     'Access-Control-Allow-Origin': '*',
   })),
   'Access-Control-Allow-Methods listing PUT is NOT a yes');
ok(!O.acceptsWriteBack(headers({})), 'no headers at all is a no');
ok(!O.acceptsWriteBack(null), 'nothing at all is a no');
ok(!O.acceptsWriteBack(headers({ Allow: 'GET, INPUT, HEAD' })),
   'a method merely containing "PUT" as a substring is not PUT');

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
