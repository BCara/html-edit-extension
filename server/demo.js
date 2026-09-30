/*
 * Quick Edit — try save-in-place without touching a real server.
 *
 * Serves a directory over http with the save route mounted, so you can walk the
 * whole loop — open, edit, Save to server, confirm the bytes on disk — before
 * putting anything on a machine you care about.
 *
 *   node server/demo.js <directory> [port]
 *
 * The static half is deliberately minimal, but its ETag and Last-Modified are
 * generated the same way express.static generates them, which is the part that
 * has to match for a conditional PUT to round trip.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const quickEditSave = require('./quick-edit-save.js');

const root = path.resolve(process.argv[2] || process.cwd());
const port = Number(process.argv[3] || 8099);

if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error('Not a directory: ' + root);
  process.exit(1);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
};

const save = quickEditSave({ root, keepBackups: 5 });

http.createServer((req, res) => {
  save(req, res, () => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD, OPTIONS, PUT' });
      res.end();
      return;
    }

    let rel;
    try {
      rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
    } catch (e) {
      res.writeHead(400); res.end('bad path'); return;
    }
    const file = path.resolve(root, '.' + path.posix.normalize('/' + rel));
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403); res.end('outside root'); return;
    }

    fs.stat(file, (err, stat) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }

      if (stat.isDirectory()) {
        const items = fs.readdirSync(file)
          .filter((n) => !n.startsWith('.'))
          .map((n) => {
            const href = path.posix.join(rel, n);
            return '<li><a href="' + href.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '">' +
                   n.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</a></li>';
          }).join('\n');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><meta charset="utf-8"><title>Index</title>' +
                '<h1>Quick Edit demo server</h1><ul>' + items + '</ul>');
        return;
      }

      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': stat.size,
        ETag: quickEditSave.statTag(stat),
        'Last-Modified': stat.mtime.toUTCString(),
        'Cache-Control': 'public, max-age=0',
      });
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file).pipe(res);
    });
  });
}).listen(port, () => {
  console.log('Quick Edit demo server');
  console.log('  serving   ' + root);
  console.log('  at        http://localhost:' + port + '/');
  console.log('  save      PUT is enabled; backups in .quick-edit-backups/');
  console.log('');
  console.log('Open a .html file from that URL in Chrome, click the Quick Edit');
  console.log('icon, and the button should read "Save to server".');
});
