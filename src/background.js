/*
 * VibeRevise — service worker.
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
 *
 * AI, when the user has added a key, is the one exception to "sends nothing
 * anywhere", and it is made here rather than in the page for a reason: the key
 * lives in extension storage and never leaves this worker. The content script
 * sends the prompt it built; this adds the key, makes the request to the one
 * address the user chose and was granted, and hands back only the answer.
 */

/*
 * The classifier decides which documents VibeRevise will touch; the popup gets
 * its verdict relayed rather than re-deriving it.
 *
 * Chrome runs this file as a service worker, where importScripts() is how a
 * dependency is pulled in. Firefox runs it as an event page, where that
 * function does not exist and the manifest lists origins.js ahead of this file
 * instead. Both end up with the same global, so everything below is identical.
 */
if (typeof importScripts === 'function') importScripts('/src/lib/origins.js', '/src/lib/ai.js');
const Origins = self.VibeReviseOrigins;
const AI = self.VibeReviseAI;

// Order matters: each library defines globals the next file uses.
const INJECT_FILES = [
  'src/lib/origins.js',
  'packages/html-splice/src/tokenizer.js',
  'src/lib/mapping.js',
  'packages/html-splice/src/splice.js',
  'src/lib/islands.js',
  'src/lib/blocks.js',
  'src/lib/structures.js',
  'src/lib/comments.js',
  'src/lib/prompt.js',
  'src/lib/ai.js',
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
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'vibeRevise:ping' });
    if (pong && pong.ready) return;
  } catch (e) {
    // No receiver yet — expected on the first click.
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: INJECT_FILES });
}

/*
 * The active tab, if VibeRevise is willing to edit it.
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

  /*
   * No URL at all is not "neither local nor LAN". Chrome withholds a file://
   * tab's URL from activeTab while "Allow access to file URLs" is off, so a
   * local document — including one on a network share, file://host/... —
   * arrives here looking like nothing. Say what is actually wrong.
   */
  if (!tab.url && !(await fileSchemeAllowed())) return { tab, code: 'no-file-access' };

  const verdict = classify(tab.url);
  if (!verdict.kind) return { tab, code: 'not-editable', reason: verdict.reason };

  /*
   * Chrome gates file:// behind a per-extension toggle and will tell you
   * whether it is on. Firefox has no such toggle and no such function, so
   * "cannot ask" is treated as "not blocked" rather than as a refusal — the
   * read still falls back to asking the user to pick the file if it fails.
   */
  if (verdict.kind === 'file' && !(await fileSchemeAllowed())) {
    return { tab, code: 'no-file-access' };
  }
  return { tab, kind: verdict.kind };
}

// Firefox cannot be asked, and "cannot ask" counts as allowed — see above.
async function fileSchemeAllowed() {
  if (typeof chrome.extension === 'undefined'
      || typeof chrome.extension.isAllowedFileSchemeAccess !== 'function') return true;
  return chrome.extension.isAllowedFileSchemeAccess();
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

/*
 * AI settings: { provider, baseUrl, model, apiKey } under one storage key.
 * Kept in chrome.storage.local — this browser profile on this device, never
 * synced — and read only here and on the settings page.
 */
async function aiConfig() {
  const o = await chrome.storage.local.get('ai');
  return o.ai ? AI.normaliseConfig(o.ai) : null;
}

/*
 * Whether AI can be used right now, and what to call it. Never the key.
 *
 * Granted host access is part of "configured": a key for an address Chrome has
 * not been told VibeRevise may reach would fail on every request, and saying
 * so up front beats a network error later.
 */
async function aiStatus() {
  const cfg = await aiConfig();
  if (!cfg) return { configured: false, problem: 'Not set up yet.' };
  const problem = AI.configProblem(cfg);
  if (problem) return { configured: false, problem };
  const pattern = AI.permissionPattern(cfg);
  const granted = await chrome.permissions.contains({ origins: [pattern] });
  const host = new URL(cfg.baseUrl).host;
  if (!granted) {
    return { configured: false, host, problem: 'VibeRevise has not been allowed to reach ' + host +
             ' yet. Open AI settings and press Save to allow it.' };
  }
  return { configured: true, label: AI.describe(cfg), host };
}

async function aiComplete(request) {
  const status = await aiStatus();
  if (!status.configured) return { ok: false, message: status.problem };
  if (!request || typeof request.system !== 'string' || typeof request.user !== 'string') {
    return { ok: false, message: 'That was not a request VibeRevise knows how to send.' };
  }
  // Only the fields a prompt has. Whatever else arrives is not forwarded.
  const req = {
    system: request.system,
    user: request.user,
    schema: request.schema || null,
    maxTokens: Math.min(Math.max(+request.maxTokens || 8000, 16), 32000),
  };
  return AI.complete(await aiConfig(), req, (url, init) => fetch(url, init));
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

  if (msg.type === 'vibeRevise:inspect' || msg.type === 'vibeRevise:toggle' ||
      msg.type === 'vibeRevise:save') {
    const forward = msg.type === 'vibeRevise:inspect' ? 'vibeRevise:scan' : msg.type;
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
  if (msg.type === 'vibeRevise:state') {
    setBadge(sender.tab && sender.tab.id, msg.active, msg.unsaved);
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'vibeRevise:readFile') {
    readFile(msg.url).then(sendResponse);
    return true;
  }

  // The popup asks before it does anything, so that a served document never
  // gets shown the file:// permission dance it has no use for.
  if (msg.type === 'vibeRevise:classifyActive') {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const verdict = classify(tab && tab.url);
      sendResponse({ ok: true, kind: verdict.kind, reason: verdict.reason });
    })();
    return true;
  }

  if (msg.type === 'vibeRevise:hasFilePermission') {
    chrome.permissions.contains({ origins: ['file:///*'] })
      .then(function (granted) { sendResponse({ ok: true, granted }); });
    return true;
  }

  if (msg.type === 'vibeRevise:download') {
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

  /*
   * AI. Only ever from VibeRevise itself: a page cannot reach this listener
   * (there is no externally_connectable), so no website can spend the user's
   * key or read the answers.
   */
  if (msg.type === 'vibeRevise:aiStatus') {
    aiStatus().then(sendResponse, (err) => sendResponse({ configured: false, problem: String(err && err.message || err) }));
    return true;
  }

  if (msg.type === 'vibeRevise:aiComplete') {
    if (sender.id !== chrome.runtime.id) { sendResponse({ ok: false, message: 'Not allowed.' }); return; }
    aiComplete(msg.request).then(sendResponse, (err) => sendResponse({ ok: false, message: String(err && err.message || err) }));
    return true;
  }

  if (msg.type === 'vibeRevise:openOptions') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'vibeRevise:openExtensionsPage') {
    chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id });
    return;
  }
});

// A tab that navigates away has lost its content script, its islands and its
// unsaved edits along with them; the badge should not imply otherwise.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') chrome.action.setBadgeText({ tabId, text: '' });
});
