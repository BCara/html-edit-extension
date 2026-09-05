/*
 * Quick Edit — in-page prompt.
 *
 * A small card in the corner of the document, used when Quick Edit needs
 * something from the user before it can do anything: at the moment, that means
 * asking them to choose the file when Chrome will not let the extension read it
 * on its own.
 *
 * It has to live in the page rather than the popup, because opening a file
 * dialog from a popup closes the popup and cancels the whole interaction.
 *
 * Like the status bar, it renders inside a closed shadow root so the page's
 * stylesheet cannot reach it and its own styles cannot leak out, and it is
 * tagged data-quick-edit-ui so the offset map never treats it as content.
 */
(function (root) {
  'use strict';

  var UI_ATTR = 'data-quick-edit-ui';

  var CSS = [
    ':host { all: initial; }',
    '.card {',
    '  font: 13px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;',
    '  width: 300px;',
    '  padding: 14px 15px;',
    '  border-radius: 10px;',
    '  background: rgba(22, 22, 27, .95);',
    '  color: #f1f2f5;',
    '  box-shadow: 0 4px 24px rgba(0, 0, 0, .35);',
    '  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);',
    '}',
    '.title { font-weight: 600; margin-bottom: 5px; }',
    '.body { color: #b8bdc9; }',
    '.error { color: #ff9f9f; margin-top: 8px; }',
    '.error:empty { display: none; }',
    '.row { display: flex; gap: 8px; margin-top: 12px; }',
    'button {',
    '  font: inherit; border: 0; border-radius: 7px; padding: 6px 13px;',
    '  cursor: pointer; background: rgba(255, 255, 255, .13); color: inherit;',
    '}',
    'button:hover { background: rgba(255, 255, 255, .22); }',
    'button.primary { background: #5b52f0; }',
    'button.primary:hover { background: #6d64ff; }',
    'input[type=file] { display: none; }',
  ].join('\n');

  var current = null;

  function dismiss() {
    if (current && current.host.parentNode) current.host.parentNode.removeChild(current.host);
    current = null;
  }

  function build(options) {
    dismiss();

    var host = document.createElement('div');
    host.setAttribute(UI_ATTR, '');
    [['position', 'fixed'], ['right', '16px'], ['bottom', '16px'],
     ['z-index', '2147483647'], ['margin', '0'], ['padding', '0'],
     ['width', 'auto'], ['height', 'auto'], ['max-width', 'none'],
     ['transform', 'none'], ['opacity', '1'], ['visibility', 'visible'],
     ['display', 'block'], ['pointer-events', 'auto'], ['float', 'none'],
    ].forEach(function (p) { host.style.setProperty(p[0], p[1], 'important'); });

    var shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML =
      '<style>' + CSS + '</style>' +
      '<div class="card">' +
        '<div class="title"></div>' +
        '<div class="body"></div>' +
        '<div class="error"></div>' +
        '<div class="row">' +
          '<button class="go primary"></button>' +
          '<button class="cancel">Cancel</button>' +
        '</div>' +
        '<input type="file" accept=".html,.htm,.xhtml,text/html">' +
      '</div>';

    shadow.querySelector('.title').textContent = options.title;
    shadow.querySelector('.body').textContent = options.body;
    shadow.querySelector('.go').textContent = options.action;

    document.documentElement.appendChild(host);
    current = { host: host, shadow: shadow };
    return current;
  }

  /*
   * Ask the user to choose a file, and keep asking until they pick one that
   * `validate` accepts or they cancel.
   *
   * The file input is clicked from inside the button's own click handler, which
   * is what keeps the browser's user-activation requirement satisfied.
   */
  function chooseFile(options) {
    return new Promise(function (resolve, reject) {
      var ui = build(options);
      var input = ui.shadow.querySelector('input[type=file]');
      var errorEl = ui.shadow.querySelector('.error');

      ui.shadow.querySelector('.go').addEventListener('click', function () {
        errorEl.textContent = '';
        input.value = '';        // so re-picking the same file still fires change
        input.click();
      });

      ui.shadow.querySelector('.cancel').addEventListener('click', function () {
        dismiss();
        reject(new Error('cancelled'));
      });

      input.addEventListener('change', function () {
        var file = input.files && input.files[0];
        if (!file) return;
        Promise.resolve(options.validate ? options.validate(file) : null)
          .then(function (problem) {
            if (problem) { errorEl.textContent = problem; return; }
            dismiss();
            resolve(file);
          })
          .catch(function (err) { errorEl.textContent = String(err && err.message || err); });
      });
    });
  }

  root.QuickEditPrompt = { chooseFile: chooseFile, dismiss: dismiss };
})(typeof self !== 'undefined' ? self : globalThis);
