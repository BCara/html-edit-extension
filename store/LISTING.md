# Chrome Web Store listing

Copy for the submission form, plus the answers the review asks for. Everything
here is claims the extension can actually back up — a listing that overpromises
is the fastest way to a rejection and the slowest way to a refund request.

Developer registration is a one-off US$5.

---

## Name

```
Quick Edit
```

## Short description

*(132 characters maximum — this is what shows in search results.)*

```
Fix the words in an HTML document and save it with the markup untouched. Nothing is re-formatted but what you typed.
```

*(115 characters.)*

## Category

Developer Tools. It is aimed at people who are not developers, but it is used on
files that developers made, and that is where they will look for it.

## Detailed description

```
Quick Edit lets you fix the text in an HTML document without opening a code editor — and without your file coming back reformatted.

Open the document in Chrome, click the icon, click any text on the page, and type. Press Save.

THE ONE RULE

The saved file is the original file with only the words you changed replaced.

Quick Edit never re-serialises the page. Every other tool in this space hands the document to a parser and writes the tree back out, which returns the browser's idea of your file: re-indented, attributes re-quoted, comments dropped, entities rewritten. Your one-word fix arrives as a diff touching every line.

Quick Edit keeps the original source as text, tracks the exact character range each editable run occupies in it, and splices your new words into those ranges. Everything else is copied through byte for byte. If a saved file differs anywhere other than the words you deliberately changed, that is a bug, not a trade-off.

WHAT IT IS FOR

- A report, plan or hand-off document that lives as a single HTML file
- Anything generated for you as HTML that needs its wording fixed before it goes out
- Static pages a non-developer needs to correct without a round trip
- Documents served from a NAS or a local server, edited in the browser

WHERE IT WORKS

- Local files opened from file://
- Documents served from your own network: localhost, a LAN address, a NAS, a private mesh

Not on public websites. That is deliberate: the guarantee above depends on re-reading the exact document the browser parsed, which holds for a file server and does not hold for a page that renders anew on every request.

COMMENTS THAT TRAVEL WITH THE FILE

Hover a section, click the speech bubble, and leave a note. It appears in a margin down the side of the page, the way a word processor does it.

The note is stored as an ordinary HTML comment just before the section it belongs to. Nobody viewing the page in a browser sees it — but emailing the file carries it, a text editor shows it plainly, and so does anything else you hand the file to. Notes kept inside a browser extension could not travel; these live in the document.

SAVING

Chrome cannot overwrite a file:// path, so for local files Save opens the OS dialog on the original filename. You can navigate back and replace the original — deliberately, never quietly.

For a document served over your network, Save can write the file back in place, if you add the small open-source route included with the extension to your server. The write is conditional, so it cannot silently overwrite a change someone else made, and previous versions are kept.

WHAT IT DOES NOT DO

You can change words, add another block like one that is already there, and attach comments. You cannot move, delete or resize elements, change CSS, classes, attributes or styles, or replace images. The restraint is the feature.

PRIVACY

Quick Edit makes no network requests of its own, stores nothing, and sends your documents nowhere. The only network request it ever makes is to the server your own document came from, to read it and — if you ask — to save it back.
```

## Permission justifications

*(The review form asks for one per permission. Be specific; "needed for
functionality" gets rejected.)*

**activeTab**
```
Quick Edit reads and edits the document in the single tab whose toolbar icon the user clicked, and only until they navigate away. This is used to inject the editor and to read the document's text. activeTab was chosen over a standing host permission so that the extension has no access to any page unless the user explicitly invokes it on that page.
```

**scripting**
```
The editor is injected on demand with chrome.scripting.executeScript when the user clicks the toolbar icon, rather than declared as a content script that auto-runs on every page. Nothing is injected until the user asks for it.
```

**downloads**
```
Chrome cannot write back to a file:// path, so saving an edited local file is performed as a download. It is used with saveAs:true so the operating system's Save dialog always opens and the user chooses the destination. No download is ever started without the user pressing Save.
```

**file:///\* (optional host permission)**
```
Requested only if the user chooses to grant it, via a button in the popup. It lets the extension's service worker read the local HTML file the user is editing. It is optional because there is a fallback that needs no permission: the extension asks the user to pick the file with a file chooser. Installing the extension grants this nothing.
```

**Single purpose**
```
Editing the visible text of an HTML document in the browser and saving it without altering the document's markup.
```

**Data usage**
Tick: does not collect or use user data. All four sub-questions are "no". The
extension has no `storage` permission, no remote hosts, no analytics, and makes
no network request other than to the origin of the document the user opened.

## Screenshots

Five, 1280×800. Use a real document, not lorem — the DigiStayBook plan or
similar, with plausible business content.

1. **Edit mode on a real document.** Caret in a paragraph, one region outlined,
   an edited region tinted. Status bar bottom right showing "2 changes ·
   unsaved". This is the whole product in one frame.
2. **The diff.** Split image: the original file and the saved file side by side
   in a text editor with a diff gutter, showing exactly one changed line in a
   200-line file. This is the claim that sells it, so show it rather than
   asserting it.
3. **Comments in the margin.** Two cards down the right-hand side, barred to
   their sections — and an inset showing the same note as
   `<!-- comment: ... -->` in a text editor.
4. **Save to server.** The status bar button reading "Save to server", with the
   LAN URL visible in the address bar.
5. **The popup.** Region count, "Save writes: back to the server, in place",
   and the diagnostic panel.

## Before submitting

- [ ] Decide the npm name for the engine package — `html-text-splice` may be taken.
- [ ] Read the IP assignment clause in the employment contract.
- [ ] `./test/run.sh` passes.
- [ ] `./pack.sh` produces a zip with no test files or package tooling in it.
- [ ] Load the packed zip unpacked in a clean Chrome profile and walk
      `test/MANUAL.md` — the store gets the packed artefact, not the repo.
