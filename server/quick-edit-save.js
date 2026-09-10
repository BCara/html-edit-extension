/*
 * Quick Edit — save-in-place for a static file server.
 *
 * Drop this beside whatever serves your documents and Quick Edit's Save button
 * writes the file back over the network instead of dropping a copy in your
 * Downloads folder.
 *
 *   const quickEditSave = require('./quick-edit-save');
 *   const ROOT = '/volume1/nas-raw';
 *
 *   app.use('/nas-raw', quickEditSave({ root: ROOT }));   // PUT + OPTIONS
 *   app.use('/nas-raw', express.static(ROOT));            // GET, as before
 *
 * Order does not actually matter — express.static only answers GET and HEAD and
 * passes everything else along — but reading it in this order makes the pairing
 * obvious.
 *
 * Written against core node's req/res only, so it also works as a plain
 * http.createServer handler, and can be tested without a framework.
 *
 * WHAT IT REFUSES, AND WHY
 * ------------------------
 * This accepts writes from anyone who can reach the port. On a home LAN that is
 * the same trust boundary as the file server itself — anyone who can read the
 * documents can already reach the NAS — but it is a real widening, so the
 * refusals are deliberately strict:
 *
 *   - only PUT and OPTIONS; everything else falls through to the next handler
 *   - only paths that stay inside `root` after resolving symlinks
 *   - only files that ALREADY EXIST: this overwrites documents, it does not
 *     create them, so a stray PUT cannot litter the tree
 *   - only .html/.htm/.xhtml
 *   - only text/html bodies, under `maxBytes`
 *   - only from private addresses, unless you pass allowRemote: true
 *
 * CONDITIONAL WRITES
 * ------------------
 * If the client sends If-Match or If-Unmodified-Since, the file is only written
 * when it still matches — otherwise 412, and the client is told to reload. This
 * is what stops two people (or two tabs) silently overwriting each other. The
 * ETag format is byte-identical to the one express.static generates, so a
 * validator taken from a GET works here without translation.
 *
 * BACKUPS
 * -------
 * Every write copies the previous version into `.quick-edit-backups/` beside
 * the file first, timestamped, keeping the most recent `keepBackups`. Saving a
 * document in place is the one operation here that can lose work, so it never
 * happens without a way back.
 */
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const HTML_EXT = /\.x?html?$/i;
const BACKUP_DIR = '.quick-edit-backups';

/*
 * The ETag express.static would produce for this file: weak, size and mtime in
 * hex. Replicated rather than imported so this file has no dependencies; if it
 * ever drifts from Express, a conditional PUT fails closed with 412 rather than
 * writing the wrong thing.
 */
function statTag(stat) {
  return 'W/"' + stat.size.toString(16) + '-' + stat.mtime.getTime().toString(16) + '"';
}

// Weak comparison, per RFC 9110: W/"x" and "x" are the same entity here.
function tagsMatch(a, b) {
  if (!a || !b) return false;
  const strip = (t) => t.trim().replace(/^W\//, '');
  return strip(a) === strip(b);
}

function isPrivateAddress(ip) {
  if (!ip) return false;
  const h = ip.replace(/^::ffff:/, '');
  if (h === '::1' || h === 'localhost') return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const a = +m[1], b = +m[2];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) ||
         (a === 192 && b === 168) || (a === 169 && b === 254) ||
         (a === 100 && b >= 64 && b <= 127);
}

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  }, headers || {}));
  res.end(JSON.stringify(body));
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/*
 * Resolve the request path to a real file inside root, or null.
 *
 * fs.realpath is what makes this safe against a symlink inside the tree
 * pointing out of it: the check is on the resolved path, not the requested one.
 */
async function resolveTarget(root, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch (e) {
    return null;
  }
  if (rel.indexOf('\0') !== -1) return null;

  const realRoot = await fsp.realpath(root);
  const candidate = path.resolve(realRoot, '.' + path.posix.normalize('/' + rel));

  let real;
  try {
    real = await fsp.realpath(candidate);
  } catch (e) {
    return null;                                  // must already exist
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
  if (!HTML_EXT.test(real)) return null;

  const stat = await fsp.stat(real);
  if (!stat.isFile()) return null;
  return { file: real, stat };
}

async function makeBackup(file, keep) {
  if (keep <= 0) return null;
  const dir = path.join(path.dirname(file), BACKUP_DIR);
  await fsp.mkdir(dir, { recursive: true });

  const base = path.basename(file);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(dir, base + '.' + stamp);
  await fsp.copyFile(file, backup);

  // Keep the most recent `keep` for this file; the timestamp sorts lexically.
  const mine = (await fsp.readdir(dir))
    .filter((n) => n.startsWith(base + '.'))
    .sort();
  for (const old of mine.slice(0, Math.max(0, mine.length - keep))) {
    await fsp.unlink(path.join(dir, old)).catch(() => {});
  }
  return backup;
}

/*
 * Write atomically: a temp file in the same directory, fsynced, then renamed
 * over the target. rename(2) within a filesystem is atomic, so a reader either
 * sees the whole old file or the whole new one — never a half-written document.
 * The original's mode is preserved.
 */
async function writeAtomic(file, buf) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, '.' + path.basename(file) + '.' + crypto.randomBytes(6).toString('hex') + '.tmp');
  let mode;
  try { mode = (await fsp.stat(file)).mode; } catch (e) { /* keep the default */ }

  const handle = await fsp.open(tmp, 'w', mode);
  try {
    await handle.writeFile(buf);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

/*
 * quickEditSave({ root, maxBytes, keepBackups, allowRemote, logger })
 *
 * root         directory the documents live in. Required.
 * maxBytes     largest document accepted. Default 25 MB.
 * keepBackups  previous versions retained per file. Default 10; 0 disables.
 * allowRemote  accept writes from public addresses too. Default false.
 * logger       called with one line per write. Default console.log.
 */
function quickEditSave(options) {
  const opts = options || {};
  const root = opts.root;
  if (!root) throw new Error('quickEditSave: `root` is required');
  const maxBytes = opts.maxBytes || 25 * 1024 * 1024;
  const keepBackups = opts.keepBackups === undefined ? 10 : opts.keepBackups;
  const allowRemote = !!opts.allowRemote;
  const log = opts.logger === undefined ? console.log : opts.logger;

  return function handler(req, res, next) {
    const done = typeof next === 'function' ? next : () => {
      send(res, 405, { error: 'Method not allowed' }, { Allow: 'PUT, OPTIONS' });
    };

    if (req.method !== 'PUT' && req.method !== 'OPTIONS') return done();

    // OPTIONS is Quick Edit's capability probe. Answering it is what makes the
    // Save button say "Save to server" instead of quietly downloading.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        Allow: 'GET, HEAD, OPTIONS, PUT',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS, PUT',
        'Access-Control-Allow-Headers': 'Content-Type, If-Match, If-Unmodified-Since',
        'Cache-Control': 'no-store',
      });
      res.end();
      return;
    }

    (async () => {
      const remote = req.socket && req.socket.remoteAddress;
      if (!allowRemote && !isPrivateAddress(remote)) {
        return send(res, 403, { error: 'Writes are only accepted from the local network.' });
      }

      const type = String(req.headers['content-type'] || '');
      if (!/^text\/html\b/i.test(type)) {
        return send(res, 415, { error: 'Expected Content-Type: text/html' });
      }

      const target = await resolveTarget(root, req.url || '/');
      if (!target) {
        return send(res, 404, { error: 'No such HTML file under the served root.' });
      }

      // Conditional write. A client that sends no validator is trusted to know
      // what it is doing; Quick Edit always sends one.
      const currentTag = statTag(target.stat);
      const ifMatch = req.headers['if-match'];
      const ifUnmodified = req.headers['if-unmodified-since'];

      if (ifMatch && ifMatch !== '*' && !ifMatch.split(',').some((t) => tagsMatch(t, currentTag))) {
        return send(res, 412, { error: 'The file changed since you read it.' }, { ETag: currentTag });
      }
      if (!ifMatch && ifUnmodified) {
        const since = Date.parse(ifUnmodified);
        // mtime has sub-second precision, the header does not; compare at
        // second granularity or every save after the first fails.
        if (!Number.isNaN(since) && Math.floor(target.stat.mtime.getTime() / 1000) > Math.floor(since / 1000)) {
          return send(res, 412, { error: 'The file changed since you read it.' }, { ETag: currentTag });
        }
      }

      const body = await readBody(req, maxBytes);
      if (!body.length) return send(res, 400, { error: 'Empty body refused.' });
      // A document that is not valid UTF-8 would have been mangled on the way
      // here; better to refuse than to write it. Decoding and re-encoding is
      // lossless exactly when the bytes were valid UTF-8 to begin with.
      if (!Buffer.from(body.toString('utf8'), 'utf8').equals(body)) {
        return send(res, 400, { error: 'Body is not valid UTF-8.' });
      }

      const backup = await makeBackup(target.file, keepBackups);
      await writeAtomic(target.file, body);

      const after = await fsp.stat(target.file);
      const tag = statTag(after);
      if (log) {
        log('[quick-edit] wrote ' + target.file + ' (' + body.length + ' bytes) from ' +
            remote + (backup ? ', backup ' + path.basename(backup) : ''));
      }
      send(res, 200, {
        ok: true,
        bytes: body.length,
        backup: backup ? path.join(BACKUP_DIR, path.basename(backup)) : null,
      }, {
        ETag: tag,
        'Last-Modified': after.mtime.toUTCString(),
      });
    })().catch((err) => {
      const status = err && err.status ? err.status : 500;
      if (log) log('[quick-edit] save failed: ' + (err && err.message));
      if (!res.headersSent) send(res, status, { error: String(err && err.message || err) });
    });
  };
}

module.exports = quickEditSave;
module.exports.statTag = statTag;
