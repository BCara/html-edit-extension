/*
 * Quick Edit — service worker.
 *
 * Deliberately thin. It exists to do the three things a content script cannot:
 *   - inject the editor into the active tab (chrome.scripting)
 *   - start a download (chrome.downloads)
 *   - put a badge on the toolbar icon (chrome.action)
 *
 * It holds no document state. The content script owns the source string and the
 * offset map, and the file text passes through here only on its way into a save
 * the user asked for — it is never stored, and never sent anywhere else.
 */

// Order matters: each library defines globals the next file uses.
const INJECT_FILES = [
  'src/lib/tokenizer.js',
  'src/lib/mapping.js',
  'src/lib/splice.js',
  'src/lib/islands.js',
  'src/editor.js',
  'src/content.js',
];

function isLocalHtml(url) {
  return /^file:\/\/.*\.x?html?(\?|#|$)/i.test(url || '');
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

async function activeLocalTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab.');
  if (!isLocalHtml(tab.url)) return { tab, code: 'not-local-html' };
  if (!(await chrome.extension.isAllowedFileSchemeAccess())) {
    return { tab, code: 'no-file-access' };
  }
  return { tab };
}

// Relay a request from the popup to the content script, injecting it first.
async function relay(type, extra) {
  const { tab, code } = await activeLocalTab();
  if (code) return { ok: false, code, url: tab.url };
  await ensureInjected(tab.id);
  return await chrome.tabs.sendMessage(tab.id, Object.assign({ type }, extra));
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
