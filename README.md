# Quick Edit

A Chrome extension for fixing the words in an HTML document without opening a
code editor. Open it in Chrome, click the icon, edit the text on the page, save.

Works on local files (`file://`) and on documents served from your own network —
`localhost`, a LAN address, a NAS, a private mesh. Where the server accepts it,
Save writes the file back in place.

## The one rule

**The saved file is the original file with only the words you changed replaced.**

Quick Edit never re-serialises the DOM. Serialising would hand you Chrome's idea
of your file — re-indented, attributes re-quoted, comments dropped, entities
rewritten — instead of what you actually wrote. Instead it keeps the original
source text as a string, tracks the exact character range each editable text
node occupies in it, and splices new text into those ranges. Everything else in
the file is copied through untouched, byte for byte.

If a saved file differs from the original anywhere other than the words you
deliberately changed, that is a bug, not a trade-off.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this directory.

### Enable file access — required for local files

Only for `file://` documents. A document served over http(s) needs none of this:
skip to [Using it](#using-it).

Chrome does not let extensions read `file://` URLs unless you say so, per
extension. Without it Quick Edit cannot read your file at all.

1. On `chrome://extensions`, click **Details** under Quick Edit.
2. Turn on **Allow access to file URLs**.
3. Reload any local HTML file you already had open.

The popup detects when this is off and links you straight there rather than
failing silently.

## Using it

1. Open an `.html` file in Chrome — from disk, or from a server on your own
   network.
2. Click the Quick Edit icon, then **Start editing**.
3. Click any run of text and type. Editable text highlights faintly as you
   hover; the region you are in gets a solid outline, and anything you have
   changed stays tinted so you can see your own edits at a glance.
4. Press **Save** in the bar at the bottom right. The OS Save dialog opens with
   the original filename.

### Adding a block

You can add another one of something: another paragraph after a paragraph,
another bullet after a bullet, another heading after a heading. Three ways, all
equivalent:

- **Enter** with the caret at the very end of a block
- **`Ctrl`/`Cmd` + `Enter`** from anywhere in it
- the small **`+`** that appears just below a block when you hover it

The new block copies its neighbour's tag and `class`, so it looks the same, and
lands with the same indentation. It does *not* copy the `id` — two elements with
one id would be invalid — or any other attribute.

An added block you never type into is not written to the file at all. The status
bar counts them so they do not disappear on you silently.

### Comments

Hover a section and click the **speech bubble** next to the `+`. A card opens in
a margin down the right-hand side, the way a word processor does it: the section
you commented on is shaded and barred so it is obvious which note belongs to
what, and cards line up beside their section, sliding down when they would
overlap.

A comment is stored as an ordinary HTML comment just before its section:

```html
<!-- comment: needs a figure for Q3 -->
<p>Revenue grew by 12% over the quarter.</p>
```

That choice is the whole point. Notes kept inside the browser could not travel;
these live *in* the document, so emailing the file carries them, a text editor
shows them plainly, and an AI you hand the file back to reads them. Anyone just
viewing the page in a browser sees none of it.

Comments already in a file show up when you open it, so a note someone left you
comes through. Comments that are *not* Quick Edit's — a build tool's boilerplate,
a conditional comment — are never shown and never touched. Delete a comment with
the `×` on its card; a comment left empty is not written at all.

| Key | |
| --- | --- |
| `Ctrl`/`Cmd` + `S` | Save |
| `Ctrl`/`Cmd` + `Z` | Undo (including undoing an added block) |
| `Ctrl`/`Cmd` + `Shift` + `Z` (or `Ctrl` + `Y`) | Redo |
| `Enter` | Line break, or a new block at the end of one |
| `Ctrl`/`Cmd` + `Enter` | New block |

### Saving

For a **served** document whose server accepts a write-back, Save writes the
file in place over the network and the button says so. The write is conditional
on the `ETag` the document was read with, so a save cannot silently overwrite a
change someone else made in the meantime, and the server keeps timestamped
backups. See [server/README.md](server/README.md) — it is one dependency-free
file to drop into an Express app.

Otherwise Chrome cannot write back to a `file://` path, so Save is a download. The dialog
opens on the original filename, and you can navigate back to the original and
replace it — but that is your explicit choice, not something that happens
quietly. Until you do, the original on disk is untouched.

While edit mode is on, links do not navigate and forms do not submit: either one
would throw away every unsaved edit.

## Permissions, and why each one is there

| Permission | Why |
| --- | --- |
| `activeTab` | Read the document in the one tab whose icon you clicked, until you navigate away. Chosen over a standing `file:///*` host permission so the extension has no access to anything unless you ask. |
| `scripting` | Inject the editor on demand instead of auto-running on every local file you open. |
| `downloads` | Chrome cannot write back to a `file://` path, so saving is a download. Used with `saveAs: true` so the OS dialog always opens. |
| — | **Nothing at all is requested for http or https.** A content script's `fetch` carries the page's origin, so re-reading the document it is running on, and `PUT`ting it back, are ordinary same-origin requests. `activeTab` covers the injection and that is the whole story. |
| `file:///*` — **optional** | Lets the service worker open the file itself. Not granted at install: the popup asks for it on a button press, Chrome shows its own consent prompt, and declining costs you one click per file instead. |

There is no required `host_permissions`, no `storage`, and no network access of
any kind. Quick Edit makes no requests, contains no AI, and sends your document
nowhere.

### Why reading a local file is awkward

A content script cannot read the file it is running on. In Manifest V3 its
`fetch()` carries the *page's* origin, and a `file://` page is not allowed to
read `file://` URLs — it fails with a bare "Failed to fetch". So Quick Edit
tries three routes, in order of how little they ask of you:

1. **The service worker fetches it**, with the extension's own privileges. Needs
   the optional `file:///*` permission above. No interaction.
2. **The content script fetches it.** Only works if Chrome was started with
   `--allow-file-access-from-files`. Tried because it costs nothing.
3. **You choose the file.** Needs no permission at all, so this one always
   works. Quick Edit checks the filename matches and that the contents line up
   with the page before trusting it.

The popup's details panel says which route was used.

## How it works

1. **Read the source.** The file's original bytes are read as a string (see
   above for the three routes) and kept as the source of truth. The DOM is never
   read back with `innerHTML`.
2. **Tokenize the source** (`packages/html-splice/src/tokenizer.js`). A single pass records every
   character range that the HTML parser will turn into a text node — skipping
   tags, comments and the doctype, and understanding raw-text elements, quoted
   attributes containing `>`, and the newline `<pre>` swallows.
3. **Pair spans with DOM nodes** (`src/lib/mapping.js`). The browser has already
   built the real tree, so the two sequences are matched in document order and
   then *verified*: each source span, newline-normalised and entity-decoded the
   way the parser does it, must equal the node's text exactly. Anything that
   cannot be verified is simply not editable — there is no guessing.
4. **Wrap each region in its own island** (`src/lib/islands.js`). Every editable
   text node gets its own `<span contenteditable>`, so one region is one text
   node is one range of the file. The browser cannot merge, split or delete
   markup across an island boundary, which is what makes "editing the text
   cannot disturb the tags" true by construction rather than by vigilance. These
   wrappers exist only in the page; they can never reach the file.
5. **Constrain what can happen inside** (`src/editor.js`). Input types are
   allowed by whitelist, not refused by blacklist: typing, deleting and IME
   composition are allowed, and everything else — bold, lists, indentation,
   links, drops, and any input type Chrome invents next year — is refused.
   Pasting is intercepted and re-inserted as plain text.
6. **Splice** (`packages/html-splice/src/splice.js`). On save, only the ranges whose text changed
   are replaced, with the new text escaped for its context and the file's line
   ending style preserved. No edits means the source is returned unchanged, by
   construction.

Adding a block, and adding a comment, ride on the same machinery. The tokenizer records where every
tag sits, and a single recursive walk over the DOM pairs each element with its
own tags — using the tree the browser already built means nested elements of the
same name, elements the parser invented (`<tbody>`) and elements that were never
closed all fall out without any special cases. An insertion is then a
**zero-length splice** at the offset just past a closing tag: nothing is
replaced, so every byte that was in the file is still in the file, and because
nothing is written until you save, an insertion cannot invalidate any other
offset.

## Known limitations

**By design**

- **Text, blocks and comments.** You can change words, add another block like one
  that is already there, and attach comments. You cannot move, delete or resize
  elements, change CSS, classes, attributes or styles, or replace images. That
  restraint is the feature; the additions were made deliberately, after the fact.
- **No overwrite in place.** Chrome cannot write to a `file://` path. See
  [Using it](#using-it).
- **Private addresses only.** `file://`, plus http(s) on loopback, RFC1918,
  link-local, IPv6 unique-local, `.local` names and `100.64.0.0/10` (where
  Tailscale and similar meshes live). The path must still end in `.html`,
  `.htm` or `.xhtml`.

  This is not squeamishness — the model stops working on the open web. Quick
  Edit's promise rests on re-fetching the document and getting back exactly the
  bytes the browser parsed. That holds for a static file server. It does not
  hold for anything that renders per request: the second fetch returns a
  different document and the offsets describe text that is not on screen. It
  fails safe (nothing verifies, so nothing is editable) but a page where nothing
  is editable and no one can say why is a bad experience. Private addresses are
  where documents-served-as-files actually live; public origins are
  overwhelmingly applications. See `src/lib/origins.js`.
- **The only markup Quick Edit writes** is a `<br>` from a line break, the blocks
  you explicitly add, and the `<!-- comment: -->` notes you write. All of it
  appears only where you asked for it.
- **The comment margin moves the page over** while it is open, by widening the
  page's right padding. It is put back when you leave edit mode, and the file
  never hears about it — but on an unusual layout it may look odd while open.
- **No drag and drop.** Dropping content into a page is a reliable way to get
  markup into it, so drops are refused. Copy and paste instead.
- **Editing is per run of text.** Each run between tags is its own field, so the
  caret does not travel from `Hello` into `<strong>bold</strong>` — click or
  `Tab` into the next one. This is what keeps the tags safe.

**Consequences of how the parser works**

- **Entities inside an edited region are normalised.** Text is written back
  minimally escaped, so a paragraph originally containing `&#39;` or `&quot;`
  comes back as `'` or `"` *if you edit that paragraph*. `&`, `<`, `>` and
  non-breaking spaces are always re-encoded. Paragraphs you do not touch keep
  their entities byte for byte.
- **UTF-8 only.** A file declaring another charset is detected and refused
  rather than silently corrupted.
- **Reading the file may need a click.** If you decline the optional permission,
  Quick Edit asks you to choose the file each time — see above for why.
- **A few text nodes are never editable**: anything inside `<script>`, `<style>`,
  `<head>`, `<title>`, `<template>`, `<noscript>` or `<textarea>`; whitespace
  between tags; and text the parser stitched together from several places in the
  file (the whitespace after `</body>` and `</html>` is the usual example, since
  no single range covers it without swallowing the markup in between).

**Cosmetic, while edit mode is on**

- The editing wrappers are elements, and adding an element child can change what
  a selector like `:only-child` or `:nth-child` matches for its siblings. On a
  page whose CSS uses those, edit mode can look very slightly different from the
  page at rest. It goes away when you switch edit mode off, and it never reaches
  the file.
- Switching edit mode off with unsaved edits leaves the wrappers in the page,
  because they are what is holding those edits. They are styled `all: unset`, so
  they change nothing you can see. Reloading the page clears them — and loses
  the unsaved edits, which is what the "leave site?" warning is for.

## Tests

```
./test/run.sh          # everything: three node suites + three headless Chrome suites
node test/node-test.js # editor-level: islands, blocks, comments, write-back
node packages/html-splice/test/engine-test.js   # the engine on its own
node server/test-save.js                        # the save-in-place route
```

See [test/README.md](test/README.md) for what each suite covers, and
[test/MANUAL.md](test/MANUAL.md) for the ten-minute walkthrough of the things a
headless suite cannot check: installing it, reading a `file://` URL, and the
Save dialog.

## Layout

```
manifest.json           permissions, with the justification for each
src/background.js       service worker: injection, downloads, toolbar badge
src/content.js          reads the source, builds the map, routes messages
src/editor.js           edit mode: constraints, history, status bar, saving
src/lib/origins.js      which documents Quick Edit will touch, and why
src/lib/mapping.js      character ranges <-> DOM text nodes, verified
src/lib/islands.js      the contenteditable wrappers and their values
src/lib/blocks.js       where an added block goes, and what it looks like
src/lib/comments.js     reading and writing notes as HTML comments
src/lib/prompt.js       the in-page card that asks you to choose the file
packages/html-splice/   the engine, as a standalone package
  src/tokenizer.js      source text -> character ranges
  src/splice.js         escaping and offset splicing
server/                 optional: save-in-place for a static file server
src/popup/              toolbar popup and the file-access diagnostic
test/                   fixtures, suites, and the preservation procedure
```
