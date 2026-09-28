/*
 * Quick Edit — a static server for the built app.
 *
 * dist/ is plain static files, so anything that serves a directory will do;
 * this exists so there is one command to run, and something a service manager
 * can point at.
 *
 *   node serve-dist.js [port] [directory]
 *
 * Binds to localhost only. Reaching it from another device is a job for
 * whatever is in front of it — `tailscale serve` puts it behind a real
 * certificate on your tailnet, which is what the service worker needs before a
 * browser will install the app.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2] || 8700);
const ROOT = path.resolve(process.argv[3] || path.join(__dirname, 'dist'));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

http.createServer((req, res) => {
  let rel;
  try {
    rel = decodeURIComponent(req.url.split('?')[0]);
  } catch (e) {
    res.writeHead(400); return res.end('bad path');
  }
  if (rel === '/' || rel.endsWith('/')) rel += 'index.html';

  const file = path.resolve(ROOT, '.' + path.posix.normalize(rel));
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403); return res.end('outside root');
  }

  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      // The service worker caches the shell itself; letting the browser cache
      // it too makes a rebuild invisible until someone clears their data.
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log('Quick Edit serving ' + ROOT + ' on http://127.0.0.1:' + PORT);
});
