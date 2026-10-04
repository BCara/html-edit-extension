/*
 * VibeRevise — AI settings.
 *
 * The one extension page that handles the key. It lives here, not in the
 * editor's own panel, for two reasons: only an extension page may ask Chrome
 * for permission to reach the provider's address, and a key typed into a page
 * VibeRevise was injected into would be typed into somebody else's page.
 *
 * Saved under one storage key, `ai`, in chrome.storage.local: this profile on
 * this device, never synced.
 */
'use strict';

const AI = self.VibeReviseAI;
const $ = (id) => document.getElementById(id);

const els = {
  form: $('form'),
  provider: $('provider'),
  baseUrl: $('base-url'),
  baseHint: $('base-hint'),
  model: $('model'),
  key: $('key'),
  keyHint: $('key-hint'),
  showKey: $('show-key'),
  test: $('test'),
  forget: $('forget'),
  status: $('status'),
  write: $('access-write'),
  read: $('access-read'),
};

let saved = null;     // the configuration as stored, for comparing and revoking

function say(text, tone) {
  els.status.textContent = text || '';
  els.status.className = 'status' + (tone ? ' ' + tone : '');
}

Object.keys(AI.PROVIDERS).forEach((id) => {
  const opt = document.createElement('option');
  opt.value = id;
  opt.textContent = AI.PROVIDERS[id].label;
  els.provider.appendChild(opt);
});

/*
 * Switching provider fills in its address and default model, but only over
 * values that were themselves the previous provider's defaults. Something the
 * user typed — a proxy, a model name — is never thrown away by a dropdown.
 */
let lastProvider = 'anthropic';
function applyPreset(next) {
  const was = AI.PROVIDERS[lastProvider];
  const now = AI.PROVIDERS[next];
  if (!els.baseUrl.value.trim() || els.baseUrl.value.trim() === was.baseUrl) els.baseUrl.value = now.baseUrl;
  if (!els.model.value.trim() || els.model.value.trim() === was.model) els.model.value = now.model;
  els.keyHint.textContent = now.keyHint || '';
  els.baseHint.textContent = next === 'custom'
    ? 'Any server that speaks the OpenAI chat-completions format. Plain http is allowed only for servers on your own network.'
    : 'Leave as it is unless you use a proxy.';
  els.key.placeholder = now.keyRequired ? 'Paste your key' : 'Optional for a local server';
  lastProvider = next;
}
els.provider.addEventListener('change', () => applyPreset(els.provider.value));

// Read or read-and-write needs no new permission, so it saves the moment it
// changes, without the Save button's prompt.
[els.read, els.write].forEach((radio) => radio.addEventListener('change', async () => {
  if (!saved) return;
  saved = Object.assign({}, saved, { access: els.write.checked ? 'write' : 'read' });
  await chrome.storage.local.set({
    ai: { provider: saved.provider, baseUrl: saved.baseUrl, model: saved.model, apiKey: saved.apiKey, access: saved.access },
  });
  say(saved.access === 'write'
    ? 'Saved: AI suggestions can be accepted with one click.'
    : 'Saved: AI only advises. You make every change yourself.', 'good');
}));

els.showKey.addEventListener('click', () => {
  const show = els.key.type === 'password';
  els.key.type = show ? 'text' : 'password';
  els.showKey.textContent = show ? 'Hide' : 'Show';
  els.showKey.setAttribute('aria-pressed', String(show));
});

function readForm() {
  return AI.normaliseConfig({
    provider: els.provider.value,
    baseUrl: els.baseUrl.value,
    model: els.model.value,
    apiKey: els.key.value,
    access: els.write.checked ? 'write' : 'read',
  });
}

async function load() {
  const o = await chrome.storage.local.get('ai');
  saved = o.ai ? AI.normaliseConfig(o.ai) : null;
  const cfg = saved || AI.normaliseConfig({ provider: 'anthropic' });
  els.provider.value = cfg.provider;
  lastProvider = cfg.provider;
  els.baseUrl.value = cfg.baseUrl;
  els.model.value = cfg.model;
  els.key.value = cfg.apiKey;
  els.write.checked = cfg.access === 'write';
  els.read.checked = !els.write.checked;
  applyPreset(cfg.provider);
  els.test.disabled = !saved;
  els.forget.disabled = !saved;
  if (saved) {
    const granted = await chrome.permissions.contains({ origins: [AI.permissionPattern(saved)] });
    say(granted ? 'Set up: ' + AI.describe(saved) + '.'
                : 'Saved, but VibeRevise is not allowed to reach that address yet — press Save and allow.',
        granted ? 'good' : 'bad');
  }
}

// Take back host access VibeRevise no longer needs. Never file:///*, which
// belongs to reading local documents and is nothing to do with AI.
function revoke(pattern) {
  if (!pattern || pattern === 'file:///*') return Promise.resolve();
  return new Promise((resolve) => chrome.permissions.remove({ origins: [pattern] }, () => {
    void chrome.runtime.lastError;
    resolve();
  }));
}

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const cfg = readForm();
  const problem = AI.configProblem(cfg);
  if (problem) { say(problem, 'bad'); return; }

  const pattern = AI.permissionPattern(cfg);
  const host = new URL(cfg.baseUrl).host;

  // First thing this click does, with nothing awaited before it: Chrome only
  // shows its permission prompt in direct response to the user's gesture.
  chrome.permissions.request({ origins: [pattern] }, async (granted) => {
    if (chrome.runtime.lastError || !granted) {
      say('Chrome was not given permission for VibeRevise to reach ' + host + ', so nothing was saved.', 'bad');
      return;
    }
    const before = saved ? AI.permissionPattern(saved) : null;
    await chrome.storage.local.set({
      ai: { provider: cfg.provider, baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey, access: cfg.access },
    });
    if (before && before !== pattern) await revoke(before);
    saved = cfg;
    els.test.disabled = false;
    els.forget.disabled = false;
    say('Saved. VibeRevise may now reach ' + host + '. Open documents pick this up straight away.', 'good');
  });
});

els.test.addEventListener('click', async () => {
  els.test.disabled = true;
  say('Asking ' + (saved ? AI.describe(saved) : 'the provider') + ' for a one-word answer…');
  const res = await chrome.runtime.sendMessage({ type: 'vibeRevise:aiComplete', request: AI.pingRequest() })
    .catch((err) => ({ ok: false, message: String(err && err.message || err) }));
  els.test.disabled = false;
  if (res && res.ok) say('It works — ' + AI.describe(saved) + ' answered.', 'good');
  else say((res && res.message) || 'No answer.', 'bad');
});

els.forget.addEventListener('click', async () => {
  const pattern = saved ? AI.permissionPattern(saved) : null;
  await chrome.storage.local.remove('ai');
  await revoke(pattern);
  saved = null;
  els.key.value = '';
  els.test.disabled = true;
  els.forget.disabled = true;
  say('Forgotten. The key is gone from this browser and VibeRevise can no longer reach that address.', 'good');
});

load();
