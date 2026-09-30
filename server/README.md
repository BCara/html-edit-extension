# Save in place, over the network

Without this, Quick Edit's Save on an http(s) document is a download: the edited
file lands in your Downloads folder and you copy it back yourself. With it, Save
writes the file back where it came from.

`quick-edit-save.js` is a single dependency-free file. It answers two methods —
`OPTIONS`, which is how the extension discovers that save-in-place is available,
and `PUT`, which is the save.

## Installing it

Copy `quick-edit-save.js` next to whatever serves your documents, then mount it
on the same path as your static mount:

```js
const quickEditSave = require('./quick-edit-save');
const ROOT = '/volume1/nas-raw';

app.use('/nas-raw', quickEditSave({ root: ROOT }));   // PUT + OPTIONS
app.use('/nas-raw', express.static(ROOT));            // GET, as before
```

Both mounts must use the same URL prefix and the same directory, or the PUT will
resolve to a different file than the GET. Order does not matter —
`express.static` only answers GET and HEAD and passes everything else along —
but reading it in this order makes the pairing obvious.

Restart the server. Reload the document in Chrome, open Quick Edit, and the
button should now read **Save to server**. If it still says **Save**, the
extension's `OPTIONS` probe did not see `PUT` in the `Allow` header; check that
both mounts share a prefix and that nothing upstream is intercepting `OPTIONS`.

It also works as a plain `http.createServer` handler — it uses nothing but core
node's request and response objects.

## Options

| Option | Default | |
| --- | --- | --- |
| `root` | *required* | Directory the documents live in. |
| `maxBytes` | `25 * 1024 * 1024` | Largest document accepted. |
| `keepBackups` | `10` | Previous versions kept per file. `0` disables backups. |
| `allowRemote` | `false` | Accept writes from public addresses too. |
| `logger` | `console.log` | One line per write. `null` to silence. |

## What it refuses

This accepts writes from anyone who can reach the port. On a home LAN that is
the same trust boundary as the file server itself — anyone who can read the
documents can already reach the machine — but it is a real widening of what the
server does, so the refusals are strict:

- Only `PUT` and `OPTIONS`; anything else falls through untouched.
- Only paths that stay inside `root` **after resolving symlinks**, so a symlink
  inside the tree pointing out of it cannot be used to escape.
- Only files that **already exist**. This overwrites documents; it does not
  create them, so a stray PUT cannot litter the tree.
- Only `.html`, `.htm`, `.xhtml`.
- Only `text/html` bodies, valid UTF-8, under `maxBytes`, non-empty.
- Only from loopback, RFC1918, link-local, IPv6 unique-local and
  `100.64.0.0/10` (where Tailscale and similar meshes live), unless you pass
  `allowRemote: true`.

If any of that is too permissive for where you are running it, put it behind
whatever authentication the rest of the server already uses — it is ordinary
middleware.

## Not losing work

Two mechanisms, because saving a document in place is the one operation here
that can destroy something.

**Conditional writes.** Quick Edit sends the `ETag` it got when it read the
document, as `If-Match`. If the file changed in between — another tab, another
person, an editor on the NAS — the write is refused with `412` and the extension
tells you to reload rather than overwriting. The ETag format is byte-identical
to the one `express.static` generates, so a validator from a GET works here
without translation.

**Backups.** Every write first copies the previous version into
`.quick-edit-backups/` beside the file, timestamped, keeping the most recent
`keepBackups`. To undo a save, rename the newest backup back over the file.

**Atomic writes.** The new document goes to a temp file in the same directory,
is fsynced, then renamed over the target. A reader either sees the whole old
file or the whole new one, never a half-written document. The original's
permissions are preserved.

## Tests

```
node ../server/test-save.js
```

Runs the handler behind a plain http server against a throwaway tree: the happy
path, stale-ETag conflicts, path traversal, non-HTML paths, creating files,
wrong content types, empty bodies, backup retention — and a real 241 KB document
edited through the splice engine and written back, checked byte for byte.
