/*
 * Quick Edit — popup.
 *
 * Turns edit mode on and off, and carries the file-access diagnostic, which is
 * the single most likely reason for the extension to look broken: without
 * "Allow access to file URLs" the content script cannot read the file at all,
 * and silently doing nothing would be the worst possible answer.
 */
'use strict';

const stateEl = document.getElementById('state');
const actionsEl = document.getElementById('actions');
const fileAccessEl = document.getElementById('fileaccess');
const toggleEl = document.getElementById('toggle');
const saveEl = document.getElementById('save');
const grantEl = document.getElementById('grant');
const detailEl = document.getElementById('detail');
const detailBodyEl = document.getElementById('detail-body');
const footEl = document.getElementById('foot');

const REASON_LABELS = {
  whitespace: 'whitespace only',
  'blocked-ancestor': 'inside script/style/head/template',
  'raw-text': 'script or style content',
  'merged-spans': 'stitched together by the parser',
  unmapped: 'not matched to the source',
  'text-mismatch': 'failed verification',
  'out-of-order': 'out of source order',
};

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function show(html, cls) {
  stateEl.className = 'state' + (cls ? ' ' + cls : '');
  stateEl.innerHTML = html;
}

function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

/*
 * How the file was read, and whether that is worth doing something about.
 * "file picker" means the user had to choose the file by hand, which the
 * optional host permission would spare them next time.
 */
const READ_LABELS = {
  'service worker': 'read directly',
  'page fetch': 'read directly (page fetch)',
  'file picker': 'you chose the file by hand',
  server: 'fetched from the server',
};

// Where Save will put it. Worth stating up front: these are different acts.
const WRITE_LABELS = {
  server: 'back to the server, in place',
  download: 'a download you place yourself',
};

function render(res) {
  const ed = res.editor;
  clearTimeout(slowTimer);

  show('<b>' + escapeHtml(res.filename) + '</b><br>' +
       '<span class="sub">' + plural(res.stats.editable, 'editable text region') +
       (ed.active && ed.changed ? ' · ' + plural(ed.changed, 'change') : '') +
       '</span>');

  actionsEl.hidden = false;
  toggleEl.textContent = ed.active ? 'Stop editing' : 'Start editing';
  toggleEl.classList.toggle('primary', !ed.active);
  toggleEl.disabled = res.stats.editable === 0;

  saveEl.hidden = !ed.active;
  saveEl.disabled = ed.unsaved === 0;
  saveEl.classList.toggle('primary', ed.unsaved > 0);

  footEl.textContent = ed.active
    ? 'Click any text to edit it. Ctrl/Cmd+Z undoes, Ctrl/Cmd+S saves.'
    : (res.stats.editable === 0 ? 'There is no editable text in this file.' : '');

  // Offer the permission only when it would actually change anything.
  if (res.readVia === 'file picker') refreshGrantOffer();

  const rows = [
    ['Read via', READ_LABELS[res.readVia] || res.readVia || 'unknown'],
    ['Save writes', WRITE_LABELS[res.writeBack] || WRITE_LABELS.download],
    ['Editable text regions', res.stats.editable],
    ['Text nodes in document', res.stats.nodes],
    ['Text spans in source', res.stats.spans],
    ['Mapped to an offset', res.stats.mapped],
    ['File size', res.bytes.toLocaleString() + ' chars'],
  ];
  const skipped = Object.keys(res.reasons)
    .sort((a, b) => res.reasons[b] - res.reasons[a])
    .map((k) => '<dt>' + escapeHtml(REASON_LABELS[k] || k) + '</dt><dd>' + res.reasons[k] + '</dd>')
    .join('');

  detailEl.hidden = false;
  detailBodyEl.innerHTML =
    '<dl>' + rows.map(([k, v]) => '<dt>' + k + '</dt><dd>' + v + '</dd>').join('') + '</dl>' +
    (skipped ? '<p class="sub">Not editable</p><dl>' + skipped + '</dl>' : '');
}

function renderProblem(res) {
  clearTimeout(slowTimer);
  actionsEl.hidden = true;
  detailEl.hidden = true;
  footEl.textContent = '';

  if (res.code === 'version-skew') {
    show('<b>Quick Edit needs reloading.</b>' +
         '<ol><li>Open the extension settings below</li>' +
         '<li>Press the <b>reload</b> arrow on the Quick Edit card</li>' +
         '<li>Reload this page</li></ol>', 'warn');
    fileAccessEl.hidden = false;
    return;
  }

  if (res.code === 'cancelled') {
    show('No file chosen, so there is nothing to edit yet. ' +
         'Open this popup again to retry.');
    refreshGrantOffer();
    return;
  }

  if (res.code === 'not-editable') {
    // Say which rule was not met, rather than restating all of them.
    if (res.reason === 'public-origin') {
      show('This page is on the public internet. Quick Edit edits documents, not ' +
           'websites, so it works on <code>file://</code> pages and on servers ' +
           'inside your own network — <code>localhost</code>, a LAN address like ' +
           '<code>192.168.x.x</code>, or a private mesh.');
    } else if (res.reason === 'not-html') {
      show('Quick Edit needs an HTML document — a path ending in ' +
           '<code>.html</code> or <code>.htm</code>.');
    } else {
      show('Quick Edit works on local HTML files and on HTML served from your own ' +
           'network. This page is neither.');
    }
    return;
  }
  if (res.code === 'no-file-access') {
    show('<b>File access is turned off.</b> Chrome will not let Quick Edit read local ' +
         'files until you allow it:' +
         '<ol><li>Open the extension settings below</li>' +
         '<li>Turn on <b>Allow access to file URLs</b></li>' +
         '<li>Reload the page</li></ol>', 'warn');
    fileAccessEl.hidden = false;
    return;
  }
  show(escapeHtml(res.message || 'Something went wrong.'), 'warn');
}

function handle(res) {
  if (chrome.runtime.lastError) {
    renderProblem({ message: chrome.runtime.lastError.message });
    return;
  }
  if (res && res.ok) render(res);
  else renderProblem(res || { message: 'No response from the page.' });
}

/*
 * The content script may be waiting on the user to answer a prompt in the page
 * — which is behind this popup. Say so rather than sitting on "Checking…".
 */
let slowTimer = 0;
function ask(message) {
  stateEl.classList.remove('warn');
  clearTimeout(slowTimer);
  slowTimer = setTimeout(() => {
    show('Waiting on the page. If a prompt appeared at the bottom right of the ' +
         'document, answer that first — you may need to close this popup to see it.');
  }, 900);
  chrome.runtime.sendMessage(message, handle);
}

function refreshGrantOffer() {
  chrome.runtime.sendMessage({ type: 'quickEdit:hasFilePermission' }, (res) => {
    if (chrome.runtime.lastError) return;
    grantEl.hidden = !!(res && res.granted);
  });
}

/*
 * First run, before the optional file:///* permission has been granted.
 *
 * Asked here rather than after a failed read, because without it the very first
 * file would always land on "choose the file yourself" — a worse introduction
 * than one consent prompt. Declining is a first-class choice: the picker route
 * needs no permission and works just as well, one click at a time.
 */
function showSetup() {
  clearTimeout(slowTimer);
  show('<b>Nearly there.</b> Chrome does not let extensions open local files ' +
       'until you say so.');
  actionsEl.hidden = true;
  detailEl.hidden = true;
  grantEl.hidden = false;
  footEl.textContent = '';
}

document.getElementById('grant-btn').addEventListener('click', () => {
  // permissions.request must be called from a user gesture in an extension
  // page, which is exactly what this click is.
  chrome.permissions.request({ origins: ['file:///*'] }, () => {
    grantEl.hidden = true;
    // Either way, carry on: if it was refused, the read falls back to the
    // picker, which is a perfectly good answer.
    ask({ type: 'quickEdit:inspect' });
  });
});

document.getElementById('skip-btn').addEventListener('click', () => {
  grantEl.hidden = true;
  ask({ type: 'quickEdit:inspect' });
});

toggleEl.addEventListener('click', () => {
  toggleEl.disabled = true;
  ask({ type: 'quickEdit:toggle' });
});

saveEl.addEventListener('click', () => {
  saveEl.disabled = true;
  // The OS Save dialog opens over the page, which closes the popup.
  ask({ type: 'quickEdit:save' });
  window.close();
});

document.getElementById('open-extensions').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'quickEdit:openExtensionsPage' });
  window.close();
});

/*
 * On open: if the file permission is already granted, go straight to scanning.
 * If not, offer it once before doing anything that would need it.
 */
chrome.runtime.sendMessage({ type: 'quickEdit:classifyActive' }, (info) => {
  // A document served over http(s) is read with an ordinary same-origin fetch,
  // so none of the file:// permission machinery applies to it. Going straight
  // to the scan is not a shortcut — there is genuinely nothing to ask for.
  if (chrome.runtime.lastError || !info || info.kind !== 'file') {
    ask({ type: 'quickEdit:inspect' });
    return;
  }
  chrome.runtime.sendMessage({ type: 'quickEdit:hasFilePermission' }, (res) => {
    if (chrome.runtime.lastError || (res && res.granted)) {
      ask({ type: 'quickEdit:inspect' });
    } else {
      showSetup();
    }
  });
});
