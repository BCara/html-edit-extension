/*
 * Quick Edit — service worker.
 *
 * Deliberately thin. It exists to do the four things a content script cannot:
 *   - inject the editor into the active tab (chrome.scripting)
 *   - READ THE FILE (see below)
 *   - start a download (chrome.downloads)
 *   - put a badge on the toolbar icon (chrome.action)
 *
 * On reading the file: this cannot be done from the content script. In
 * Manifest V3 a content script's fetch() carries the *page's* origin, and a
 * file:// page is not permitted to read file:// URLs — the request fails with
 * a bare "Failed to fetch". (A page can only do it when Chrome is started with
 * --allow-file-access-from-files, which nobody's browser is.) The service
 * worker fetches with the extension's own privileges instead, which is the
 * supported route.
 *
 * It holds no document state. The content script owns the source string and the
 * offset map, and the file text passes through here only on its way into a save
 * the user asked for — it is never stored, and never sent anywhere else.
 */

// The classifier decides which documents Quick Edit will touch; the popup gets
// its verdict relayed rather than re-deriving it.
importScripts('/src/lib/origins.js');
const Origins = self.QuickEditOrigins;

// Order matters: each library defines globals the next file uses.
const INJECT_FILES = [
  'src/lib/origins.js',
  'packages/html-splice/src/tokenizer.js',
  'src/lib/mapping.js',
  'packages/html-splice/src/splice.js',
  'src/lib/islands.js',
  'src/lib/blocks.js',
  'src/lib/comments.js',
  'src/lib/prompt.js',
  'src/editor.js',
  'src/content.js',
];

function classify(url) {
  return Origins.classify(url || '');
}

async function ensureInjected(tabId) {
  // Ask first: re-injecting would wipe the in-page undo history and any
  // unsaved edits the islands are holding.
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'quickEdit:ping' });
    if (pong && pong.ready) return;
  } catch (e) {
    // No receiver yet — expected on the first click.
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: INJECT_FILES });
}

/*
 * The active tab, if Quick Edit is willing to edit it.
 *
 * Note which check applies to which kind. "Allow access to file URLs" is a
 * file:// concern only: an http(s) document is read by the content script with
 * a same-origin fetch, which needs no permission of any kind. That asymmetry is
 * the whole reason LAN support was cheap to add — see readSource() in
 * content.js.
 */
async function activeLocalTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab.');

  const verdict = classify(tab.url);
  if (!verdict.kind) return { tab, code: 'not-editable', reason: verdict.reason };

  if (verdict.kind === 'file' && !(await chrome.extension.isAllowedFileSchemeAccess())) {
    return { tab, code: 'no-file-access' };
  }
  return { tab, kind: verdict.kind };
}

// Relay a request from the popup to the content script, injecting it first.
async function relay(type, extra) {
  const { tab, code, reason, kind } = await activeLocalTab();
  if (code) return { ok: false, code, reason, url: tab.url };
  await ensureInjected(tab.id);
  const res = await chrome.tabs.sendMessage(tab.id, Object.assign({ type }, extra));
  if (res && typeof res === 'object') res.kind = kind;
  return res;
}

/*
 * Read a local file on behalf of the content script.
 *
 * Needs two separate things from the user, and they fail differently:
 *   - "Allow access to file URLs" on chrome://extensions (checked before we
 *     ever get here)
 *   - host access to file:///*, which is an optional permission the popup asks
 *     for on a button press
 * If either is missing, or if this build of Chrome will not fetch file: URLs
 * from a service worker at all, this returns ok:false and the content script
 * falls back to asking the user to choose the file.
 */
async function readFile(url) {
  if (classify(url).kind !== 'file') return { ok: false, code: 'not-a-file-url' };
  const granted = await chrome.permissions.contains({ origins: ['file:///*'] });
  if (!granted) return { ok: false, code: 'no-host-permission' };
  try {
    const res = await fetch(url);
    if (!res.ok) return { ok: false, code: 'http', message: 'HTTP ' + res.status };
    return { ok: true, text: await res.text() };
  } catch (err) {
    return { ok: false, code: 'fetch-failed', message: String(err && err.message || err) };
  }
}

function setBadge(tabId, active, unsaved) {
  if (typeof tabId !== 'number') return;
  chrome.action.setBadgeText({ tabId, text: active ? (unsaved ? '•' : 'on') : '' });
  chrome.action.setBadgeBackgroundColor({ tabId, color: unsaved ? '#d9a01e' : '#5b52f0' });
}

/*
 * Start the download.
 *
 * saveAs is always true. Chrome cannot overwrite a file:// path on its own, so
 * the OS dialog is both the honest way to tell the user a copy is being made
 * and the only way they can deliberately choose to replace the original.
 */
async function download(url, filename) {
  const id = await chrome.downloads.download({
    url,
    filename: (filename || 'page.html').replace(/[\\/]/g, '_'),
    saveAs: true,
  });
  return id;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'quickEdit:inspect' || msg.type === 'quickEdit:toggle' ||
      msg.type === 'quickEdit:save') {
    const forward = msg.type === 'quickEdit:inspect' ? 'quickEdit:scan' : msg.type;
    (async () => {
      try {
        const res = await relay(forward, { active: msg.active });
        if (res && res.ok && res.editor) {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          setBadge(tab && tab.id, res.editor.active, res.editor.unsaved);
        }
        sendResponse(res);
      } catch (err) {
        sendResponse({ ok: false, code: 'error', message: String(err && err.message || err) });
      }
    })();
    return true;
  }

  // Sent by the content script whenever edit mode is turned on or off.
  if (msg.type === 'quickEdit:state') {
    setBadge(sender.tab && sender.tab.id, msg.active, msg.unsaved);
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'quickEdit:readFile') {
    readFile(msg.url).then(sendResponse);
    return true;
  }

  // The popup asks before it does anything, so that a served document never
  // gets shown the file:// permission dance it has no use for.
  if (msg.type === 'quickEdit:classifyActive') {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const verdict = classify(tab && tab.url);
      sendResponse({ ok: true, kind: verdict.kind, reason: verdict.reason });
    })();
    return true;
  }

  if (msg.type === 'quickEdit:hasFilePermission') {
    chrome.permissions.contains({ origins: ['file:///*'] })
      .then(function (granted) { sendResponse({ ok: true, granted }); });
    return true;
  }

  if (msg.type === 'quickEdit:download') {
    (async () => {
      try {
        const id = await download(msg.url, msg.filename);
        sendResponse({ ok: true, downloadId: id });
      } catch (err) {
        // The content script has further fallbacks for the URL forms Chrome
        // will not accept here, so report rather than throw.
        sendResponse({ ok: false, message: String(err && err.message || err) });
      }
    })();
    return true;
  }

  if (msg.type === 'quickEdit:openExtensionsPage') {
    chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id });
    return;
  }
});

// A tab that navigates away has lost its content script, its islands and its
// unsaved edits along with them; the badge should not imply otherwise.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') chrome.action.setBadgeText({ tabId, text: '' });
});
