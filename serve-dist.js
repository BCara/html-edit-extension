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

const { isPrivateHost } = require('./src/lib/origins.js');

const PORT = Number(process.argv[2] || 8700);
// Loopback by default. QE_HOST=0.0.0.0 also answers on the LAN, which is how a
// phone reaches it over plain http without waiting on a certificate.
const HOST = process.env.QE_HOST || '127.0.0.1';
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

/*
 * /fetch?url=… — read a document from this network on the page's behalf.
 *
 * Needed because the app is served over https (a service worker will not
 * register otherwise, and without one it cannot be installed), while the
 * documents on this network are served over plain http. A browser blocks
 * fetch() from an https page to an http URL as mixed content before CORS is
 * even considered, so the page cannot read them itself. Fetching from here and
 * answering on the app's own origin sidesteps all three problems at once:
 * mixed content, CORS, and the private-network checks browsers now apply to a
 * public origin reaching into a LAN.
 *
 * This is an open proxy if it is not fenced, so it is fenced the same way the
 * extension fences itself — the SAME rule, from the same module:
 *
 *   - http(s) only, and only to loopback, RFC1918, link-local, IPv6
 *     unique-local, .local names, or the 100.64/10 mesh range
 *   - the path must end in .html, .htm or .xhtml
 *   - a size cap, and a timeout
 *
 * It answers with the bytes verbatim. It does not parse, rewrite or cache
 * them: whatever the document's own server sent is what the editor maps its
 * offsets against, and anything else would break the guarantee.
 */
const MAX_BYTES = 25 * 1024 * 1024;

function proxy(req, res, target) {
  let u;
  try {
    u = new URL(target);
  } catch (e) {
    res.writeHead(400); return res.end('not a url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    res.writeHead(400); return res.end('only http and https');
  }
  if (!isPrivateHost(u.hostname)) {
    res.writeHead(403);
    return res.end('only addresses on your own network');
  }
  if (!/\.x?html?$/i.test(u.pathname)) {
    res.writeHead(400); return res.end('only .html, .htm or .xhtml');
  }

  const client = u.protocol === 'https:' ? require('https') : http;
  const upstream = client.get(u, { timeout: 15000 }, (up) => {
    if (up.statusCode !== 200) {
      res.writeHead(502);
      up.resume();
      return res.end('the document server answered ' + up.statusCode);
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    let size = 0;
    up.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BYTES) { up.destroy(); res.end(); }
    });
    up.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy(new Error('timed out')));
  upstream.on('error', (err) => {
    if (res.headersSent) return res.end();
    res.writeHead(502);
    res.end('could not reach it: ' + err.message);
  });
}

http.createServer((req, res) => {
  const [pathname, query] = (req.url || '/').split('?');
  if (pathname === '/fetch') {
    const target = new URLSearchParams(query || '').get('url');
    if (!target) { res.writeHead(400); return res.end('no url given'); }
    return proxy(req, res, target);
  }

  let rel;
  try {
    rel = decodeURIComponent(pathname);
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
}).listen(PORT, HOST, () => {
  console.log('Quick Edit serving ' + ROOT + ' on http://' + HOST + ':' + PORT);
});
