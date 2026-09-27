/*
 * Quick Edit — the web app.
 *
 * The extension edits the page it was injected into. This edits a file you
 * choose, rendered into an iframe, and the editor is told to work on that
 * document instead of this one. Everything below the editor — the tokenizer,
 * the offset map, the islands, the structures — is the same code, unchanged.
 *
 * WHY AN IFRAME
 * -------------
 * The offset map pairs spans of the source text with nodes of the DOM the
 * browser built from exactly those bytes. So the document has to be really
 * parsed, by the real parser, and left alone afterwards. An iframe written to
 * with document.write() gives precisely that, and keeps the user's CSS from
 * leaking into the app's chrome or the other way round.
 *
 * It is sandboxed with allow-same-origin and NOT allow-scripts. That pairing is
 * the point: no script inside the user's document can run — it could otherwise
 * reach `parent` and take over the app, since the frame shares this origin —
 * while this page keeps full DOM access to edit it. (allow-same-origin together
 * WITH allow-scripts is the combination that is unsafe; this is the other one.)
 *
 * SAVING
 * ------
 * Three routes, best first, decided by what the browser actually offers:
 *
 *   1. A file handle — Chrome, Edge and Opera on the desktop. The file the user
 *      opened is rewritten in place. No copy, no Downloads folder, no dialog
 *      after the first one. This is the thing the extension cannot do at all:
 *      Chrome will not let an extension write to a file:// path.
 *   2. The share sheet — Android. Hands the edited file to whichever app it
 *      came from. Offered only when navigator.canShare() agrees, because iOS
 *      Safari has been known to accept the call and share the text instead.
 *   3. A download. Always available, always last.
 */
'use strict';

var els = {
  open: document.getElementById('open'),
  openMain: document.getElementById('open-main'),
  save: document.getElementById('save'),
  frame: document.getElementById('frame'),
  welcome: document.getElementById('welcome'),
  filename: document.getElementById('filename'),
  toast: document.getElementById('toast'),
  saveStory: document.getElementById('save-story'),
  saveStoryTitle: document.getElementById('save-story-title'),
  dropHint: document.getElementById('drop-hint'),
};

var current = {
  name: 'document.html',
  handle: null,      // a FileSystemFileHandle, when the browser gave us one
  source: '',
};

var CAN_HANDLE = typeof window.showOpenFilePicker === 'function';

// --- chrome ------------------------------------------------------------------

var toastTimer = 0;
function toast(message, tone) {
  els.toast.textContent = message;
  els.toast.className = 'toast' + (tone ? ' ' + tone : '');
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { els.toast.hidden = true; }, 5000);
}

/*
 * Say up front how saving will work here, because it differs by browser and
 * finding out at save time is the wrong moment. Firefox and Safari do not
 * implement the file pickers — Mozilla considers them harmful — so those users
 * get a download and should know before they start.
 */
function describeSaving() {
  if (CAN_HANDLE) {
    els.saveStoryTitle.textContent = 'Saving';
    els.saveStory.textContent =
      'Save writes straight back to the file you opened. No copy, nothing in ' +
      'your Downloads folder.';
    return;
  }
  els.saveStoryTitle.textContent = 'Saving in this browser';
  els.saveStory.textContent =
    'This browser will not let a web page write to a file, so Save gives you ' +
    'the edited copy to put back yourself. Chrome or Edge on a computer can ' +
    'write in place.';
  els.dropHint.hidden = true;     // no drag and drop worth speaking of on touch
}

// --- opening -----------------------------------------------------------------

async function openWithPicker() {
  var handles;
  try {
    handles = await window.showOpenFilePicker({
      types: [{
        description: 'HTML document',
        accept: { 'text/html': ['.html', '.htm', '.xhtml'] },
      }],
      multiple: false,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') return;   // they changed their mind
    throw err;
  }
  var handle = handles[0];
  var file = await handle.getFile();
  await load(await file.text(), file.name, handle);
}

function openWithInput() {
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = '.html,.htm,.xhtml,text/html';
  input.addEventListener('change', function () {
    var file = input.files && input.files[0];
    if (file) file.text().then(function (text) { load(text, file.name, null); });
  });
  input.click();
}

function openFile() {
  (CAN_HANDLE ? openWithPicker() : Promise.resolve(openWithInput()))
    .catch(function (err) { toast('Could not open that file: ' + err.message, 'warn'); });
}

/*
 * A file that is not UTF-8 would have been decoded wrongly on the way in, and
 * writing it back would corrupt every non-ASCII character. The extension
 * refuses these rather than quietly mangling them, and so does this.
 */
function encodingProblem(source) {
  if (source.indexOf('�') !== -1) {
    return 'This file is not valid UTF-8. Quick Edit would corrupt it, so it will not open it.';
  }
  var meta = /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(source.slice(0, 4096));
  if (meta) {
    var cs = meta[1].toLowerCase();
    if (cs !== 'utf-8' && cs !== 'utf8') {
      return 'This file declares charset "' + meta[1] + '". Quick Edit only handles UTF-8.';
    }
  }
  return null;
}

// Write the document into the frame with the real parser, and wait for it.
function render(source) {
  return new Promise(function (resolve) {
    var frame = els.frame;
    frame.hidden = false;
    var d = frame.contentDocument;
    d.open();
    d.write(source);
    d.close();
    // document.write is synchronous, but give layout a frame before measuring
    // anything, since the editor positions controls against real geometry.
    requestAnimationFrame(function () { resolve(d); });
  });
}

async function load(source, name, handle) {
  var problem = encodingProblem(source);
  if (problem) { toast(problem, 'warn'); return; }

  current.source = source;
  current.name = name || 'document.html';
  current.handle = handle;

  var d = await render(source);
  var map = window.QuickEditMap.build(source, d);

  if (!map.stats.editable) {
    toast('Quick Edit could not find any editable text in that file.', 'warn');
  }

  window.QuickEditEditor.init({
    doc: d,
    source: source,
    map: map,
    filename: current.name,
    saveFile: saveFile,
  });
  window.QuickEditEditor.setActive(true);

  els.welcome.hidden = true;
  els.filename.hidden = false;
  els.filename.textContent = current.name;
  els.save.hidden = false;
  document.body.classList.add('editing');
  watchUnsaved();

  toast(map.stats.editable + ' editable text region' +
        (map.stats.editable === 1 ? '' : 's') + ' — click any of them and type.');
}

// --- saving ------------------------------------------------------------------

async function writeThroughHandle(text) {
  var writable = await current.handle.createWritable();
  await writable.write(new Blob([text], { type: 'text/html;charset=utf-8' }));
  await writable.close();
  return { ok: true, where: 'Saved to ' + current.name };
}

function fileFor(text) {
  return new File([text], current.name, { type: 'text/html' });
}

async function shareFile(text) {
  await navigator.share({ files: [fileFor(text)], title: current.name });
  return { ok: true, where: 'Shared ' + current.name };
}

function downloadFile(text) {
  var url = URL.createObjectURL(new Blob([text], { type: 'text/html;charset=utf-8' }));
  var a = document.createElement('a');
  a.href = url;
  a.download = current.name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 60000);
  return { ok: true, where: 'Downloaded ' + current.name + ' — put it back over the original' };
}

/*
 * Handed to the editor as options.saveFile, so Save in its own bar comes here
 * rather than going near the extension's download plumbing.
 */
function saveFile(text) {
  if (current.handle) {
    return writeThroughHandle(text).catch(function (err) {
      // Permission can lapse, or the file can have gone. Never lose the edits
      // over it — fall back rather than fail.
      console.warn('[Quick Edit] writing through the handle failed:', err);
      return downloadFile(text);
    });
  }

  if (navigator.canShare && navigator.canShare({ files: [fileFor(text)] })) {
    return shareFile(text).catch(function (err) {
      if (err && err.name === 'AbortError') return { ok: false, message: 'Sharing cancelled' };
      return downloadFile(text);
    });
  }

  return Promise.resolve(downloadFile(text));
}

// --- wiring ------------------------------------------------------------------

function watchUnsaved() {
  setInterval(function () {
    var s = window.QuickEditEditor.status();
    els.save.disabled = s.unsaved === 0;
  }, 300);

  window.addEventListener('beforeunload', function (e) {
    if (window.QuickEditEditor.status().unsaved > 0) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

/*
 * ?src=<url> opens a document straight into the editor.
 *
 * Convenient for a bookmark, and the seed of something larger: a link that
 * opens somebody else's document ready to be marked up is the whole shape of
 * sending a document out for review. The URL has to be same-origin or
 * CORS-permitted, and the file is fetched, not uploaded — nothing leaves the
 * browser either way.
 *
 * There is no file handle behind a fetched document, so Save will share or
 * download rather than write in place. That is stated when it opens rather
 * than discovered at save time.
 */
function openFromQuery() {
  var src = new URLSearchParams(location.search).get('src');
  if (!src) return;
  fetch(src, { credentials: 'same-origin' })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    })
    .then(function (text) {
      var name = decodeURIComponent(src.split('/').pop().split('?')[0]) || 'document.html';
      return load(text, name, null);
    })
    .catch(function (err) {
      toast('Could not open ' + src + ' — ' + err.message, 'warn');
    });
}

els.open.addEventListener('click', openFile);
els.openMain.addEventListener('click', openFile);
els.save.addEventListener('click', function () { window.QuickEditEditor.save(); });

// Drop a file anywhere. Only useful with a pointer, so it is not advertised on
// touch, but it costs nothing to leave working.
['dragover', 'drop'].forEach(function (type) {
  document.addEventListener(type, function (e) {
    e.preventDefault();
    if (type !== 'drop') return;
    var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) file.text().then(function (text) { load(text, file.name, null); });
  });
});

describeSaving();
openFromQuery();

// Exposed for the test suite: driving a real file picker from a headless
// browser is not possible, so the suite calls load() directly with the bytes a
// picker would have handed over.
window.__quickEditApp = {
  load: load,
  saveFile: saveFile,
  current: current,
  canHandle: CAN_HANDLE,
};
