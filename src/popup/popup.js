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

function render(res) {
  const ed = res.editor;

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

  const rows = [
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
  actionsEl.hidden = true;
  detailEl.hidden = true;
  footEl.textContent = '';

  if (res.code === 'not-local-html') {
    show('Quick Edit only works on local HTML files — a page opened from ' +
         '<code>file://</code> ending in <code>.html</code> or <code>.htm</code>.');
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

function ask(message) {
  stateEl.classList.remove('warn');
  chrome.runtime.sendMessage(message, handle);
}

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

ask({ type: 'quickEdit:inspect' });
