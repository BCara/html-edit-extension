# Chrome Web Store listing

Copy for the submission form, plus the answers the review asks for. Everything
here is claims the extension can actually back up — a listing that overpromises
is the fastest way to a rejection and the slowest way to a refund request.

Developer registration is a one-off US$5.

---

## Name

```
VibeRevise
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
VibeRevise lets you fix the text in an HTML document without opening a code editor — and without your file coming back reformatted.

Open the document in Chrome, click the icon, click any text on the page, and type. Press Save.

THE ONE RULE

The saved file is the original file with only the words you changed replaced.

VibeRevise never re-serialises the page. Every other tool in this space hands the document to a parser and writes the tree back out, which returns the browser's idea of your file: re-indented, attributes re-quoted, comments dropped, entities rewritten. Your one-word fix arrives as a diff touching every line.

VibeRevise keeps the original source as text, tracks the exact character range each editable run occupies in it, and splices your new words into those ranges. Everything else is copied through byte for byte. If a saved file differs anywhere other than the words you deliberately changed, that is a bug, not a trade-off.

WHAT IT IS FOR

- A report, plan or hand-off document that lives as a single HTML file
- Anything generated for you as HTML that needs its wording fixed before it goes out
- Static pages a non-developer needs to correct without a round trip
- Documents served from a NAS or a local server, edited in the browser

WHERE IT WORKS

- Local files opened from file://
- Documents served from your own network: localhost, a LAN address, a NAS, a private mesh

- Any other web page, as a copy: edit it, comment on it, save the edited HTML as a file. The site itself is never written to, and nothing is sent anywhere.

Saving back to the server it came from is deliberately limited to your own network. The guarantee above depends on re-reading the exact document the browser parsed; that holds for a file server and does not hold for a page that renders anew on every request, and somebody else's site is not yours to overwrite in any case.

A page built in the browser cannot be edited, because the HTML the server sent has almost none of its text in it. VibeRevise detects that and says so.

COMMENTS THAT TRAVEL WITH THE FILE

Hover a section, click the speech bubble, and leave a note. It appears in a margin down the side of the page, the way a word processor does it.

The note is stored as an ordinary HTML comment just before the section it belongs to. Nobody viewing the page in a browser sees it — but emailing the file carries it, a text editor shows it plainly, and so does anything else you hand the file to. Notes kept inside a browser extension could not travel; these live in the document.

SAVING

Chrome cannot overwrite a file:// path, so for local files Save opens the OS dialog on the original filename. You can navigate back and replace the original — deliberately, never quietly.

For a document served over your network, Save can write the file back in place, if you add the small open-source route included with the extension to your server. The write is conditional, so it cannot silently overwrite a change someone else made, and previous versions are kept.

YOUR NAME, AND WHAT CHANGED

Add your name once and it goes on the comments you leave. A list of changes shows everything Save would write, paragraph by paragraph, with who made each change. Names are whatever each person types — there is no sign-in — which is what a team that trusts each other needs.

WHAT IT DOES NOT DO

You can change words, add another block like one that is already there, and attach comments. You cannot move, delete or resize elements, change CSS, classes, attributes or styles, or replace images. The restraint is the feature.

PRIVACY

VibeRevise has no servers and collects nothing: no analytics, no accounts. It talks to the server your own document came from, to read it and, if you ask, save it back.

AI is optional and off by default. Add an API key for Claude, OpenAI, OpenRouter, Gemini, or a model on your own computer, and you can ask for a rewrite, a proofread or a reply to a comment. Only then, and only when you press the button, are the words of those paragraphs sent, straight to the service you chose. Every answer is a suggestion you accept or dismiss. The markup is never touched.

It stores your name, your comments setting and, if you add them, your AI provider, model and key, all in your browser only. Your key is never visible to the pages you edit.
```

## Permission justifications

*(The review form asks for one per permission. Be specific; "needed for
functionality" gets rejected.)*

**activeTab**
```
VibeRevise reads and edits the document in the single tab whose toolbar icon the user clicked, and only until they navigate away. This is used to inject the editor and to read the document's text. activeTab was chosen over a standing host permission so that the extension has no access to any page unless the user explicitly invokes it on that page.
```

**scripting**
```
The editor is injected on demand with chrome.scripting.executeScript when the user clicks the toolbar icon, rather than declared as a content script that auto-runs on every page. Nothing is injected until the user asks for it.
```

**downloads**
```
Chrome cannot write back to a file:// path, so saving an edited local file is performed as a download. It is used with saveAs:true so the operating system's Save dialog always opens and the user chooses the destination. No download is ever started without the user pressing Save.
```

**storage**
```
Stores, in the user's own browser profile, the name they type to sign their comments, whether comments are rendered visibly in saved documents, and — only if the user adds them — their AI provider, address, model and API key. Nothing about any document is stored.
```

**https://\*/\* and http://\*/\* (optional host permissions)**
```
Used only for the optional AI feature, which is off until the user adds their own API key for an AI service they choose (Anthropic, OpenAI, OpenRouter, Google Gemini, or any compatible address, including a model running on their own computer). Nothing is granted at install. When the user saves their AI settings, the settings page requests access to the single host they typed — for example https://api.anthropic.com/* — and Chrome's own prompt names it. The background service worker then sends that host only the text the user asks it to work on, only when they press a button. Changing the address or removing the key revokes the permission. The patterns are broad only because the address is the user's choice.
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

Declare it accurately — an inaccurate data
disclosure is a common reason for rejection.

With AI in the extension, "tick nothing" is no longer accurate. When the
user turns AI on, text from the page goes to a third party (the AI provider
they chose), and so does their key, as the credential for that provider. The
Web Store counts data sent off the device as handled, even when it goes to a
service the user picked and never to the developer. Tick:

- **Website content.** The text of the paragraphs the user asks AI to work on.
- **Authentication information.** The user's own API key, sent only to the
  provider it belongs to.

Then explain in the justification box: off by default; sent only on an
explicit button press; only to the provider the user configured; nothing to
the developer, who runs no servers. This is my reading of the form. Check the
current wording when you submit, because it changes.

Nothing else is collected: there is no analytics, no tracking and no account.
The name the user types is stored locally and written only into documents they
save themselves.

Certify all three: data is not sold to third parties; not used or transferred
for purposes unrelated to the single purpose; not used to determine
creditworthiness.

A privacy policy URL is required once any category is ticked. The text is in
`store/PRIVACY.md` — publish it somewhere stable and paste the link.

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

- [ ] Set a contact address. `packages/html-splice/COMMERCIAL.md` currently
      says `CONTACT-ADDRESS-NOT-SET`, which is deliberate — it fails loudly
      rather than shipping a wrong address quietly. `store/PRIVACY.md` needs
      the same one. Use an address for this product, not a work address.
- [ ] Set `git config user.email` for this repository. Until it is set,
      commits are attributed to whatever the global identity is, and the
      existing history carries the old one.
- [ ] Publish `store/PRIVACY.md` and paste its URL into the privacy field.
- [ ] Decide the npm name for the engine package — `html-text-splice` may be taken.
- [ ] Read the IP assignment clause in the employment contract.
- [ ] `./test/run.sh` passes.
- [ ] `./pack.sh` produces a zip with no test files or package tooling in it.
- [ ] Load the packed zip unpacked in a clean Chrome profile and walk
      `test/MANUAL.md` — the store gets the packed artefact, not the repo.
