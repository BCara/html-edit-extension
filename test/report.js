/*
 * Shared reporting for the browser test pages.
 *
 * Results go into the page as plain text so that headless Chrome's --dump-dom
 * can carry them back to the terminal, and the last line is a machine-readable
 * verdict that test/run.sh greps for.
 */
(function (root) {
  'use strict';

  var out = null;
  var summary = null;
  var tally = { pass: 0, fail: 0 };

  function mount(outId, summaryId) {
    out = document.getElementById(outId);
    summary = document.getElementById(summaryId);
    if (out) out.textContent = '';
  }

  function line(cls, text) {
    if (!out) return;
    var el = document.createElement('span');
    el.className = cls;
    el.textContent = text + '\n';
    out.appendChild(el);
  }

  function heading(text) { line('head', text); }

  function ok(cond, name, detail) {
    if (cond) {
      tally.pass++;
      line('pass', '  PASS  ' + name);
    } else {
      tally.fail++;
      line('fail', '  FAIL  ' + name + (detail ? ' — ' + detail : ''));
    }
    return !!cond;
  }

  function eq(actual, expected, name) {
    return ok(actual === expected, name,
              'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }

  function finish() {
    var verdict = tally.fail === 0 ? 'ALL PASS' : 'FAILURES';
    var text = 'QE-RESULT: ' + verdict + ' — ' + tally.pass + ' passed, ' + tally.fail + ' failed';
    if (summary) summary.textContent = text;
    document.title = text;
    return text;
  }

  root.Report = {
    mount: mount, line: line, heading: heading,
    ok: ok, eq: eq, finish: finish, tally: tally,
  };
})(typeof self !== 'undefined' ? self : globalThis);
