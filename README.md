# Quick Edit

A Chrome extension for fixing the words in a local HTML file without opening a
code editor. Open the file in Chrome, click the icon, edit the text on the page,
save.

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

### Enable file access — required

Chrome does not let extensions read `file://` URLs unless you say so, per
extension. Without it Quick Edit cannot read your file at all.

1. On `chrome://extensions`, click **Details** under Quick Edit.
2. Turn on **Allow access to file URLs**.
3. Reload any local HTML file you already had open.

The popup detects when this is off and links you straight there rather than
failing silently.

## Using it

1. Open a local `.html` file in Chrome.
2. Click the Quick Edit icon, then **Start editing**.
3. Click any run of text and type. Editable text highlights faintly as you
   hover; the region you are in gets a solid outline, and anything you have
   changed stays tinted so you can see your own edits at a glance.
4. Press **Save** in the bar at the bottom right. The OS Save dialog opens with
   the original filename.

| Key | |
| --- | --- |
| `Ctrl`/`Cmd` + `S` | Save |
| `Ctrl`/`Cmd` + `Z` | Undo |
| `Ctrl`/`Cmd` + `Shift` + `Z` (or `Ctrl` + `Y`) | Redo |
| `Enter` | Insert a line break |

Chrome cannot write back to a `file://` path, so Save is a download. The dialog
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

There is no `host_permissions`, no `storage`, and no network access of any kind.
Quick Edit makes no requests, contains no AI, and sends your document nowhere.

## How it works

1. **Fetch the source.** The file's original bytes are read as a string and kept
   as the source of truth. The DOM is never read back with `innerHTML`.
2. **Tokenize the source** (`src/lib/tokenizer.js`). A single pass records every
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
6. **Splice** (`src/lib/splice.js`). On save, only the ranges whose text changed
   are replaced, with the new text escaped for its context and the file's line
   ending style preserved. No edits means the source is returned unchanged, by
   construction.

## Known limitations

**By design**

- **Text only.** You cannot move, add, delete or resize elements, or change CSS,
  classes, attributes, styles or images. That restraint is the feature.
- **No overwrite in place.** Chrome cannot write to a `file://` path. See
  [Using it](#using-it).
- **Local files only.** `http://` and `https://` pages are not supported.
- **Enter inserts a `<br>`.** This is the one deliberate exception to "text
  only": pressing Enter adds a tag your file did not have. It only ever appears
  inside a region you actively edited, and it is the only markup Quick Edit can
  ever add.
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
./test/run.sh          # everything: node unit tests + two headless Chrome suites
node test/node-test.js # tokenizer, splice and write-back only, no browser needed
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
src/lib/tokenizer.js    source text -> character ranges
src/lib/mapping.js      character ranges <-> DOM text nodes, verified
src/lib/islands.js      the contenteditable wrappers and their values
src/lib/splice.js       escaping and offset splicing
src/popup/              toolbar popup and the file-access diagnostic
test/                   fixtures, suites, and the preservation procedure
```
