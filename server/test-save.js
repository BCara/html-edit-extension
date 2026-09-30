/*
 * Quick Edit — save-in-place route tests.
 *
 * Runs the handler behind a plain http server against a throwaway tree, so it
 * needs no framework and no network. The last section is the real thing: the
 * DigiStayBook plan, edited through the splice engine and written back, checked
 * byte for byte.
 *
 *   node server/test-save.js
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const quickEditSave = require('./quick-edit-save.js');
const { tokenize, replaceSpans, applyEdits } = require('../packages/html-splice/index.js');

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
function section(t) { console.log('\n' + t); }

function request(port, method, urlPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

(async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'qe-save-'));
  await fsp.mkdir(path.join(root, 'sub'), { recursive: true });
  const doc = path.join(root, 'sub', 'doc.html');
  const ORIGINAL = '<!doctype html>\n<html><body>\n<h1>Original heading</h1>\n<p>Body text.</p>\n</body></html>\n';
  await fsp.writeFile(doc, ORIGINAL, 'utf8');
  await fsp.writeFile(path.join(root, 'notes.txt'), 'not html', 'utf8');

  // Somewhere outside the root, to be reached by traversal if the guard fails.
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'qe-outside-'));
  await fsp.writeFile(path.join(outside, 'secret.html'), '<p>should never be written</p>', 'utf8');

  const handler = quickEditSave({ root, keepBackups: 3, logger: null });
  const server = http.createServer((req, res) => handler(req, res, () => {
    // Stand in for express.static: GET returns the file and an ETag in the
    // same format, which is what makes the conditional PUT round trip.
    if (req.method === 'GET') {
      const file = path.join(root, decodeURIComponent(req.url));
      try {
        const stat = fs.statSync(file);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          ETag: quickEditSave.statTag(stat),
          'Last-Modified': stat.mtime.toUTCString(),
        });
        res.end(fs.readFileSync(file));
        return;
      } catch (e) { /* fall through */ }
    }
    res.writeHead(404); res.end('nope');
  }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const PUT_HEADERS = { 'Content-Type': 'text/html; charset=utf-8' };

  section('capability probe');
  {
    const res = await request(port, 'OPTIONS', '/sub/doc.html');
    eq(res.status, 204, 'OPTIONS answers');
    ok(/\bPUT\b/.test(res.headers.allow || ''), 'and advertises PUT, which is what the extension looks for');
  }

  section('the happy path');
  {
    const read = await request(port, 'GET', '/sub/doc.html');
    eq(read.status, 200, 'the document reads back');
    const etag = read.headers.etag;
    ok(/^W\/"[0-9a-f]+-[0-9a-f]+"$/.test(etag), 'the ETag has express.static\'s shape', etag);

    const edited = ORIGINAL.replace('Original heading', 'Edited heading');
    const res = await request(port, 'PUT', '/sub/doc.html',
      { headers: Object.assign({ 'If-Match': etag }, PUT_HEADERS), body: edited });
    eq(res.status, 200, 'a conditional PUT with the current ETag is accepted');
    eq(await fsp.readFile(doc, 'utf8'), edited, 'and the file on disk is exactly what was sent');
    ok(res.headers.etag && res.headers.etag !== etag, 'a fresh ETag comes back for the next save');
    ok(res.json && res.json.backup, 'a backup was reported');

    const backups = await fsp.readdir(path.join(root, 'sub', '.quick-edit-backups'));
    eq(backups.length, 1, 'and exists on disk');
    eq(await fsp.readFile(path.join(root, 'sub', '.quick-edit-backups', backups[0]), 'utf8'),
       ORIGINAL, 'holding the version that was replaced');
  }

  section('conflicts');
  {
    const stale = 'W/"1-1"';
    const before = await fsp.readFile(doc, 'utf8');
    const res = await request(port, 'PUT', '/sub/doc.html',
      { headers: Object.assign({ 'If-Match': stale }, PUT_HEADERS), body: '<p>clobbered</p>' });
    eq(res.status, 412, 'a stale ETag is refused');
    eq(await fsp.readFile(doc, 'utf8'), before, 'and the file is untouched');
    ok(res.headers.etag, 'the current ETag comes back so the client can recover');
  }

  section('refusals');
  {
    let res = await request(port, 'PUT', '/../' + path.basename(outside) + '/secret.html',
      { headers: PUT_HEADERS, body: '<p>x</p>' });
    ok(res.status === 404 || res.status === 400, 'path traversal is refused', 'got ' + res.status);
    eq(await fsp.readFile(path.join(outside, 'secret.html'), 'utf8'),
       '<p>should never be written</p>', 'and the file outside the root is untouched');

    res = await request(port, 'PUT', '/notes.txt', { headers: PUT_HEADERS, body: 'x' });
    eq(res.status, 404, 'a non-HTML path is refused');

    res = await request(port, 'PUT', '/sub/does-not-exist.html', { headers: PUT_HEADERS, body: '<p>x</p>' });
    eq(res.status, 404, 'creating a new file is refused — this overwrites, it does not create');

    res = await request(port, 'PUT', '/sub/doc.html',
      { headers: { 'Content-Type': 'application/json' }, body: '{}' });
    eq(res.status, 415, 'a non-HTML content type is refused');

    res = await request(port, 'PUT', '/sub/doc.html', { headers: PUT_HEADERS, body: '' });
    eq(res.status, 400, 'an empty body is refused');

    res = await request(port, 'DELETE', '/sub/doc.html');
    eq(res.status, 404, 'other methods fall through to the next handler');
  }

  section('backup retention');
  {
    for (let i = 0; i < 5; i++) {
      const read = await request(port, 'GET', '/sub/doc.html');
      await request(port, 'PUT', '/sub/doc.html', {
        headers: Object.assign({ 'If-Match': read.headers.etag }, PUT_HEADERS),
        body: '<p>version ' + i + '</p>\n',
      });
      // mtime has second granularity on some filesystems; keep stamps distinct.
      await new Promise((r) => setTimeout(r, 12));
    }
    const backups = await fsp.readdir(path.join(root, 'sub', '.quick-edit-backups'));
    eq(backups.length, 3, 'only the most recent keepBackups are retained');
  }

  section('end to end — the real document, through the splice engine');
  {
    const sample = '/tmp/claude-1000/-home-superuser/5f97b6e3-d8a2-4aa1-92f5-b65afde24857/scratchpad/a.html';
    if (!fs.existsSync(sample)) {
      console.log('  SKIP  the fetched document is not present');
    } else {
      const src = await fsp.readFile(sample, 'utf8');
      const real = path.join(root, 'plan.html');
      await fsp.writeFile(real, src, 'utf8');

      const spans = tokenize(src);
      const target = spans.find((s) => s.raw.trim() === '2.1 Product');
      ok(!!target, 'found the heading to edit');

      const edited = replaceSpans(src, [{ span: target, text: '2.1 Product & pricing' }]);
      const read = await request(port, 'GET', '/plan.html');
      const res = await request(port, 'PUT', '/plan.html', {
        headers: Object.assign({ 'If-Match': read.headers.etag }, PUT_HEADERS),
        body: edited,
      });
      eq(res.status, 200, 'the 241 KB document saves in place');

      const after = await fsp.readFile(real, 'utf8');
      eq(after, edited, 'byte-identical to what the engine produced');
      // The typed text is " & pricing", but "&" is written back as "&amp;", so
      // the file grows by the ESCAPED length. That is the whole contract:
      // what lands in the file is valid markup for what the user typed.
      eq(after.length - src.length, ' &amp; pricing'.length,
         'and grows by exactly the escaped form of what was typed');
      eq(applyEdits(src, []), src, 'a no-op save would still have changed nothing');

      // Everything outside the edited range must be untouched.
      eq(after.slice(0, target.start), src.slice(0, target.start), 'every byte before the edit is unchanged');
      eq(after.slice(target.start + '2.1 Product &amp; pricing'.length),
         src.slice(target.end), 'every byte after the edit is unchanged');
      ok(after.includes('2.1 Product &amp; pricing'), 'the ampersand was escaped on the way in');
    }
  }

  server.close();
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.rm(outside, { recursive: true, force: true });

  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + ' — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
