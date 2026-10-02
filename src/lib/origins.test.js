/*
 * VibeRevise — origins tests. Pure functions, no DOM.
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

section('classify — what VibeRevise will touch');
for (const [url, want] of [
  ['file:///home/c/a.html', 'file'],
  ['file:///home/c/a.txt', null],
  ['http://192.168.1.71:5000/nas-raw/projects/plan.html#market-position', 'lan'],
  ['http://localhost:8095/index.html', 'lan'],
  ['http://127.0.0.1:8080/a.htm', 'lan'],
  ['http://10.1.2.3/x.html', 'lan'],
  ['http://172.16.0.1/x.html', 'lan'],
  // Outside RFC1918 (172.16–31 only), so this is the public internet.
  ['http://172.32.0.1/x.html', 'copy'],
  ['http://100.110.36.48:5000/x.html', 'lan'],
  ['https://nas.local/doc.html', 'lan'],
  ['https://example.com/a.html', 'copy'],
  // A hosted document very often has no extension. 'copy' never writes back,
  // so the path tells us nothing worth refusing over; coverage is the gate.
  ['https://example.com/docs/getting-started', 'copy'],
  ['https://example.com/', 'copy'],
  // A private server is held to the stricter rule: an extensionless route
  // there is far more likely to be an application than a document.
  ['http://192.168.1.71:5000/api/route', null],
  ['chrome://extensions', null],
  ['not a url at all', null],
]) {
  ok(O.classify(url).kind === want, (want || 'refused') + ': ' + url.slice(0, 62),
     'got ' + O.classify(url).kind);
}

/*
 * The guarantee that makes 'copy' safe to offer at all. Somebody else's
 * website is not ours to write to, and this is the one place that decides it,
 * so it is asserted here rather than left to each caller to remember.
 */
section('mayWriteBack — only a server on your own network');
ok(O.mayWriteBack('lan'), 'a LAN server may be written back to');
ok(!O.mayWriteBack('copy'), 'a public page never is');
ok(!O.mayWriteBack('file'), 'and a local file is saved, not PUT');
ok(!O.mayWriteBack(null), 'and nothing unclassified is');
for (const url of ['https://example.com/a.html', 'https://example.com/docs/x',
                   'http://172.32.0.1/x.html']) {
  ok(!O.mayWriteBack(O.classify(url).kind),
     'no write-back for ' + url.slice(0, 48));
}

section('downloadName — what the saved file is called');
for (const [url, want] of [
  // A name of its own is kept, so a document saved off a NAS keeps its name.
  ['http://192.168.1.71:5000/nas/plan.html', 'plan.html'],
  ['http://192.168.1.71:5000/nas/plan.html#section', 'plan.html'],
  ['file:///home/c/DIGISTAYBOOK_PLAN.html', 'DIGISTAYBOOK_PLAN.html'],
  ['https://example.com/a/b/notes.htm', 'notes.htm'],
  // A hosted page has no name, so one is built that says where it came from.
  ['https://example.com/', 'example.com.html'],
  ['https://example.com/docs/getting-started', 'example.com-docs-getting-started.html'],
  ['https://docs.example.com/guide/v2/', 'docs.example.com-guide-v2.html'],
  ['https://example.com/a%20b/c d', 'example.com-a-b-c-d.html'],
  ['not a url', 'page.html'],
]) {
  ok(O.downloadName(url) === want, 'name: ' + url.slice(0, 50) + ' -> ' + want,
     'got ' + O.downloadName(url));
}

/*
 * This string becomes a download filename, so a path separator or a control
 * character in it would be somebody else's URL choosing where a file lands.
 */
section('downloadName — a URL cannot steer where the file goes');
for (const url of [
  'https://example.com/../../etc/passwd',
  'https://example.com/a%2Fb%2Fc',
  'https://example.com/%2e%2e%2f%2e%2e%2fshadow',
  'https://example.com/a%00b',
  'https://example.com/%5Cwindows%5Csystem32',
]) {
  const name = O.downloadName(url);
  ok(!/[\\/\x00-\x1f:]/.test(name), 'no separators or control chars: ' + name);
  ok(!/^\.|\.\./.test(name), 'no leading dot and no traversal: ' + name);
  ok(/\.x?html?$/i.test(name), 'and it still ends .html: ' + name);
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
