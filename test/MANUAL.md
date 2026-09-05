# Manual test walkthrough

The automated suites (`./test/run.sh`) cover the mapping, the splicing and the
editing logic. Three things they cannot cover, because they need a real browser
with a real extension installed and a real Save dialog:

- that Chrome will let the extension read a `file://` URL at all
- that the download actually happens, and by which of the three paths
- that it feels right to use

This is the walkthrough for those. It should take about ten minutes.

---

## 0. What you need

- Google Chrome (or Edge/Brave — anything Chromium, version 100+)
- This folder, unzipped somewhere permanent. Chrome reads it from disk every
  time it starts, so don't leave it in Downloads or a temp folder.
- A terminal, to compare files afterwards.

Throughout, `QE/` means wherever you unzipped this folder.

---

## 1. Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** — top right.
3. Click **Load unpacked** and select the `QE/` folder (the one containing
   `manifest.json`).

**Expected:** a "Quick Edit" card appears with an indigo I-beam icon, version
0.1.0, and **no red "Errors" button**.

> If there is an Errors button, click it and send me what it says — that would
> be a manifest or service-worker problem.

Pin the extension to the toolbar (puzzle-piece icon → pin) so you can see the
badge.

---

## 2. Enable file access

This is the step everyone forgets, so the extension is built to tell you about
it rather than silently do nothing.

There are **two separate permissions** here and they are easy to confuse:

- **Allow access to file URLs** — a toggle on `chrome://extensions`. Without it
  Quick Edit cannot touch local files at all. This section.
- **`file:///*` host access** — an optional permission the popup asks for with a
  button. Without it Quick Edit still works, but has to ask you to choose the
  file each time. Section 3.

1. Still on `chrome://extensions`, click **Details** under Quick Edit.
2. Turn on **Allow access to file URLs**.

**First, though, check the diagnostic works.** Before turning it on:

1. Open `QE/test/fixtures/simple.html` in Chrome — File → Open File, or drag it
   into a tab. The address bar should read `file:///.../simple.html`.
2. Click the Quick Edit icon.

**Expected:** an orange panel saying *"File access is turned off"* with numbered
instructions and an **Open extension settings** button.

Now turn the setting on, reload the `simple.html` tab, and continue.

---

## 3. The second permission

With `simple.html` open and reloaded, click the Quick Edit icon.

**Expected on the very first use:**

```
Nearly there. Chrome does not let extensions open local
files until you say so.

[ Allow direct file access ]  [ Choose it myself ]
```

Click **Allow direct file access**. Chrome shows its own consent prompt for
`file:///*` — accept it.

> **Both answers work, and I would like you to try the other one too.** If you
> click *Choose it myself* — or decline Chrome's prompt — a card appears at the
> bottom right of the *page* asking you to pick the file. Choose the same
> `simple.html` and everything works identically from there. That route needs no
> permission at all, which is why it exists.

---

## 4. Smoke test — can it see the file?

**Expected:**

```
simple.html
7 editable text regions

[ Start editing ]
```

Expand **What Quick Edit found**. Alongside the counts there is a **Read via**
row — this is the one I most want to hear about:

- `read directly` — the service worker opened the file. Best case.
- `you chose the file by hand` — the service worker could not, and the picker
  took over. Works fine, but tell me.

> If you get *"Could not read the file"* and no picker card appears, something
> is wrong: send me the message and whatever the page Console (F12) says.

---

## 5. The headline test: no edits means no change

**This is the one that matters.** Everything else is a convenience; this is the
promise.

1. On `simple.html`, click **Start editing**.
2. The page should look **exactly as it did** — same fonts, same spacing,
   nothing shifted. A small dark pill appears bottom-right: `Edit mode · no
   changes`, with Save (greyed out) and Done.
3. Hover over a paragraph: it picks up a faint indigo tint and outline. Hover
   over the whitespace between paragraphs: nothing highlights.
4. **Change nothing.** The Save button is disabled, which is correct — there is
   nothing to save. To test this path anyway, type a character in a paragraph
   and then press `Ctrl`/`Cmd`+`Z` to undo it. Save is now enabled again with
   the text back to the original.
5. Click **Save**. The OS Save dialog opens, prefilled `simple.html`.
6. Save it to your Downloads folder (**not** over the original).

Now compare. Pick whichever line matches your machine:

```bash
# macOS / Linux
cmp QE/test/fixtures/simple.html ~/Downloads/simple.html && echo IDENTICAL

# Anywhere with git installed
git diff --no-index QE/test/fixtures/simple.html ~/Downloads/simple.html && echo IDENTICAL

# Windows PowerShell
(Get-FileHash QE\test\fixtures\simple.html).Hash -eq (Get-FileHash $HOME\Downloads\simple.html).Hash
```

**Expected:** `IDENTICAL` (or `True`). No output from `cmp` and no output from
`git diff` both mean the files match to the byte.

> **If this fails, stop and send me the diff.** Everything else in the extension
> is built on this being true.

---

## 6. Edit one word, and check only that word moved

1. Open `QE/test/fixtures/nested-inline.html`.
2. Start editing. The first paragraph is
   `Hello **bold *and italic*** world`.
3. Click on the word **world** and change it to **planet**. Only that run should
   be editable — clicking "bold" puts you in a *separate* field; the caret will
   not travel from one into the other. That separation is what keeps the tags
   safe.
4. The edited region stays tinted amber. The pill reads `1 change · unsaved`.
5. Save to Downloads, then:

```bash
git diff --no-index QE/test/fixtures/nested-inline.html ~/Downloads/nested-inline.html
```

**Expected:** exactly one changed line, and the only difference on it is
`world` → `planet`:

```diff
-<p>Hello <strong>bold <em>and italic</em></strong> world</p>
+<p>Hello <strong>bold <em>and italic</em></strong> planet</p>
```

**What would be a failure:** the `<strong>`/`<em>` tags moving, gaining
attributes, or disappearing; the indentation changing; any *other* line
appearing in the diff.

---

## 7. The tricky files

Same routine for each — edit one word in the paragraph named, save, diff.

| File | Edit this | Expected diff |
| --- | --- | --- |
| `entities.html` | the paragraph *"This paragraph has no entities…"* | one line. Every `&amp;` `&nbsp;` `&#39;` `&quot;` `&eacute;` elsewhere in the file is **untouched** |
| `comments-doctype.html` | *"Visible paragraph one."* | one line. The long XHTML doctype, the `<!--[if lt IE 9]>` block and every comment are unchanged |
| `messy.html` | *"First paragraph, never closed"* | one line. Uppercase tags stay uppercase, `alt='A cat, sitting > lying'` keeps its single quotes, ragged indentation stays ragged |
| `scripty.html` | *"Editable paragraph between the script blocks."* | one line. The whole `<script>` block is byte-identical — and while editing, try to click into `var html = "<p>…"` inside the script: **nothing should highlight or accept a caret** |
| `crlf.html` | *"Costs were flat."* | one line. The file must still have CRLF line endings — see below |

CRLF check after editing `crlf.html`:

```bash
file ~/Downloads/crlf.html          # macOS/Linux: should say "with CRLF line terminators"
```

---

## 8. Typing behaviour

On any fixture, in edit mode:

| Try this | Expected |
| --- | --- |
| Type `<b>` and `&` into a paragraph, save | The file contains `&lt;b&gt;` and `&amp;`, never a raw `<`. The page still shows `<b>` as text |
| Press **Enter** mid-paragraph | The line breaks. Saved file gains one `<br>` at that spot and nothing else |
| Copy some **bold text from a web page**, paste it in | Only the plain words arrive — no bold, no tags. Check the saved file has no `<b>`/`<span>` |
| Press `Ctrl`/`Cmd`+`B` | Nothing happens. The pill flashes *"Quick Edit changes words, not formatting"* |
| Drag an image or text into the page | Refused, with a message in the pill |
| Click a link | Does not navigate. Pill says *"Links do not navigate while edit mode is on"* |
| `Ctrl`/`Cmd`+`Z` several times, then `Ctrl`/`Cmd`+`Shift`+`Z` | Undo walks back through your edits across different paragraphs; redo replays them. The change count updates as you go |
| Select a whole paragraph and delete it | The text goes; a small dashed placeholder box remains so you can click back into it. Saved file has empty tags — e.g. `<p id="x"></p>` — with the tags themselves intact |
| Click **Done** with unsaved changes, then the icon → **Start editing** again | Your edits are still there |

---

## 9. The unsaved-changes warning

1. Make an edit. Do **not** save.
2. Try to close the tab, or press F5.

**Expected:** Chrome's *"Leave site? Changes you made may not be saved"* dialog.

3. Cancel, save, then try again. **Expected:** no warning the second time.

---

## 10. Saving over the original (the real workflow)

1. Edit `simple.html`, click Save.
2. In the dialog, navigate to `QE/test/fixtures/`, keep the name `simple.html`,
   and confirm the replace prompt.
3. Reload the tab.

**Expected:** your edit is now in the file on disk and survives the reload.

Put it back afterwards:

```bash
cd QE && git checkout test/fixtures/simple.html   # if you cloned it
# or just re-copy it from the archive
```

---

## 11. Which save path was used

Open DevTools (F12) → Console **on the document tab**, then save.

**Expected:** `[Quick Edit] saved via blob URL`

Also acceptable: `saved via data URL`. That means the first path was rejected
and the fallback took over — worth telling me about, but it still works.

If you see `downloads API unavailable, falling back to a download link`, the
file lands in Downloads with no dialog. Also worth telling me about.

---

## 12. A big file

1. Open `QE/test/fixtures/large.html`. It is about 1 MB, 2,748 sections.
   It ships in the zip. If you cloned the repo instead, it is not committed —
   generate it with `node QE/test/make-large.js`, or skip this step.
2. Click Start editing.

**Expected:** a pause of well under a second, then 27,481 editable regions.
Scrolling and typing should feel normal.

---

## What to send me if something breaks

- Which step, and what you saw instead
- The output of the failing `git diff --no-index`
- Anything red in the page Console (F12) — filter for `Quick Edit`
- Anything under **Errors** on the `chrome://extensions` card, and the
  service-worker log (click **service worker** on that card)
