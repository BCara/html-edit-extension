/*
 * VibeRevise — the in-page prompt, the parts that can be tested without a
 * browser.
 *
 * prompt.js draws into a closed shadow root, so what it renders cannot be read
 * back by a test. What CAN be checked is the thing that has actually gone
 * wrong here repeatedly: the arguments handed to the file pickers. The button
 * label was clipped to "Choo" and then to "Ch", the save picker opened in
 * Downloads instead of beside the document, and none of it was covered because
 * "it needs a browser" was treated as "it cannot be tested at all".
 *
 * window and document are stubbed to the small surface the module touches at
 * load, which is enough to exercise saveAs() and the exported constants.
 */
'use strict';

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
function section(t) { console.log('\n' + t); }

// --- the smallest window the module will load against -----------------------

let lastSaveOptions = null;
let saveResult;

global.self = global;
global.document = {
  createElement: () => ({
    setAttribute() {}, appendChild() {}, attachShadow: () => ({ innerHTML: '', querySelector: () => null }),
    style: { setProperty() {} },
  }),
  documentElement: { appendChild() {} },
};
global.window = {
  // Present, so CAN_HANDLE is true — the branch that matters.
  showOpenFilePicker: () => Promise.resolve([]),
  showSaveFilePicker: (opts) => { lastSaveOptions = opts; return saveResult; },
};

require('./prompt.js');
const Prompt = global.VibeRevisePrompt;

async function main() {
section('the module loads and reports what the browser can do');
ok(Prompt, 'prompt.js exports something');
eq(Prompt.canHandle, true, 'canHandle follows showOpenFilePicker being present');
ok(typeof Prompt.saveAs === 'function', 'saveAs is exported');

section('saveAs — the picker opens where the document is');
{
  const handle = { kind: 'file', name: 'plan.html' };
  saveResult = Promise.resolve(handle);

  const got = await Prompt.saveAs('DIGISTAYBOOK_PLAN.html', handle);
  eq(got, handle, 'the chosen handle comes back');

  const o = lastSaveOptions;
  eq(o.suggestedName, 'DIGISTAYBOOK_PLAN.html', 'the file keeps its own name');
  eq(o.startIn, handle, 'and the picker starts beside the file we already have');
  ok(typeof o.id === 'string' && o.id.length > 0,
     'an id is set, which is what makes the browser reopen the last folder');
  ok(o.types && o.types[0].accept['text/html'].indexOf('.html') !== -1,
     'and it offers HTML');
}

section('saveAs — with nothing to start from');
{
  saveResult = Promise.resolve({ name: 'x.html' });
  await Prompt.saveAs('x.html');
  // undefined rather than null: the API treats null as a value and complains.
  eq(lastSaveOptions.startIn, undefined, 'startIn is left unset rather than nulled');
  ok(lastSaveOptions.id, 'but the id is still there, so it reopens the last folder');
}

section('saveAs — cancelling is an answer, not a failure');
{
  const abort = new Error('user aborted');
  abort.name = 'AbortError';
  saveResult = Promise.reject(abort);
  eq(await Prompt.saveAs('x.html'), null, 'a cancelled picker resolves to null');
}

section('saveAs — a browser that refuses the API does not throw');
{
  saveResult = Promise.reject(new Error('not allowed here'));
  eq(await Prompt.saveAs('x.html'), null, 'any other refusal also resolves to null');

  const had = global.window.showSaveFilePicker;
  delete global.window.showSaveFilePicker;
  eq(await Prompt.saveAs('x.html'), null, 'and so does not having the API at all');
  global.window.showSaveFilePicker = had;
}

section('canWrite — asking before writing');
{
  eq(await Prompt.canWrite(null), false, 'no handle is not writable');
  eq(await Prompt.canWrite({}), false, 'nor is something that cannot make a writable');

  const granted = { createWritable: () => {}, queryPermission: () => Promise.resolve('granted') };
  eq(await Prompt.canWrite(granted), true, 'an already-granted handle needs no prompt');

  let asked = 0;
  const prompts = {
    createWritable: () => {},
    queryPermission: () => Promise.resolve('prompt'),
    requestPermission: () => { asked++; return Promise.resolve('granted'); },
  };
  eq(await Prompt.canWrite(prompts), true, 'one that needs asking is asked');
  eq(asked, 1, 'exactly once');

  const denied = {
    createWritable: () => {},
    queryPermission: () => Promise.resolve('denied'),
    requestPermission: () => { throw new Error('should not be asked'); },
  };
  eq(await Prompt.canWrite(denied), false, 'and a denied handle is not asked again');
}

}

main().then(function () {
  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') +
              ' — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}).catch(function (err) {
  // A crash is a failure, not a silent zero — see test/report.js for the time
  // this exact distinction let a dead suite report ALL PASS.
  console.log('  FAIL  suite crashed — ' + (err && err.stack || err));
  process.exit(1);
});
