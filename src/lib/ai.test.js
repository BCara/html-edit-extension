/*
 * Quick Edit — AI rewrite tests. No network: a fake client stands in for the
 * API, and the real SDK's error classes are used to check error wording.
 *   node src/lib/ai.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const AI = require('./ai.js');

// The vendored SDK, run at global scope the way importScripts() runs it.
require('vm').runInThisContext(
  fs.readFileSync(path.join(__dirname, '..', 'vendor', 'anthropic-sdk.js'), 'utf8'),
  { filename: 'anthropic-sdk.js' });
const Anthropic = global.QuickEditAnthropicSDK.Anthropic;

let pass = 0, fail = 0;
const ok = (c, n, d) => c ? (pass++, console.log('  PASS  ' + n))
                          : (fail++, console.log('  FAIL  ' + n + (d ? ' — ' + d : '')));
const eq = (a, b, n) => ok(a === b, n, 'expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));
const section = (t) => console.log('\n' + t);
const reply = (obj, extra) => Object.assign({
  model: 'claude-opus-5-5', stop_reason: 'end_turn',
  content: [{ type: 'text', text: JSON.stringify(obj) }],
}, extra || {});

section('models');
eq(AI.DEFAULT_MODEL, 'claude-opus-5-5', 'the default is Claude Opus 5.5');
eq(AI.MODELS.map((m) => m.id).join(','), 'claude-opus-5-5,claude-sonnet-5-5,claude-haiku-4-5',
   'cheaper models are offered, not chosen for the user');
eq(AI.modelById('nonsense').id, 'claude-opus-5-5', 'an unknown id falls back to the default');

section('the request');
{
  const p = AI.buildParams({ segments: ['Revenue grew by ', '12%', ' over the quarter.'],
                             instruction: 'Shorter', model: 'claude-opus-5-5' });
  eq(p.model, 'claude-opus-5-5', 'names the model');
  eq(p.output_config.format.type, 'json_schema', 'asks for structured output');
  eq(p.output_config.effort, 'low', 'at low effort — it is a small rewrite');
  eq(p.fallbacks, 'default', 'with server-side fallbacks on');
  eq(p.betas && p.betas[0], 'server-side-fallback-2026-07-01', 'under the header that form needs');
  ok(p.thinking === undefined, 'and no thinking setting, which Opus 5.5 rejects if disabled');
  const body = JSON.parse(p.messages[0].content);
  eq(body.segment_count, 3, 'tells the model how many segments to return');
  ok(!/</.test(p.messages[0].content.replace(/\\u003c/g, '')), 'and sends no markup at all');
}
{
  const p = AI.buildParams({ segments: ['x'], instruction: 'y', model: 'claude-haiku-4-5' });
  ok(p.output_config.effort === undefined, 'Haiku 4.5: no effort, which it rejects');
  ok(p.fallbacks === undefined && p.betas === undefined, 'Haiku 4.5: no fallbacks, which it does not take');
}
{
  const long = 'a'.repeat(5000);
  const p = AI.buildParams({ segments: ['x'], instruction: 'y', before: long, after: long });
  const body = JSON.parse(p.messages[0].content);
  ok(body.context_before.length <= 1500 && body.context_after.length <= 1500,
     'context either side is capped, so a long document does not make every edit dearer');
}

section('reading the answer — nothing malformed reaches the document');
eq(AI.readResult(reply({ segments: ['Revenue rose ', '12%', '.'] }), 3).segments.length, 3,
   'a well-formed answer is accepted');
const throws = (fn, code) => { try { fn(); return false; } catch (e) { return e.code === code; } };
ok(throws(() => AI.readResult(reply({ segments: ['one', 'two'] }), 3), 'shape'),
   'a different number of segments is refused — the formatting would move');
ok(throws(() => AI.readResult(reply({ nope: 1 }), 1), 'shape'), 'a missing segments field is refused');
ok(throws(() => AI.readResult(reply({ segments: [1, 2] }), 2), 'shape'), 'non-string segments are refused');
ok(throws(() => AI.readResult({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] }, 1), 'shape'),
   'text that is not JSON is refused');
ok(throws(() => AI.readResult(reply({ segments: ['x'] }, { stop_reason: 'refusal' }), 1), 'refusal'),
   'a refusal is reported as one, checked before the content');
ok(throws(() => AI.readResult(reply({ segments: ['x'] }, { stop_reason: 'max_tokens' }), 1), 'truncated'),
   'a cut-off answer is refused');
{
  const r = { stop_reason: 'end_turn', content: [
    { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } },
    { type: 'text', text: JSON.stringify({ segments: ['ok'] }) },
  ] };
  eq(AI.readResult(r, 1).segments[0], 'ok', 'a fallback block ahead of the text is stepped over');
}

section('showing the change');
{
  const d = AI.diffWords('Revenue grew by 12% over the quarter.', 'Revenue rose 12% this quarter.');
  const text = (op) => d.filter((p) => p.op !== op).map((p) => p.text).join('');
  eq(text('add'), 'Revenue grew by 12% over the quarter.', 'dropping the additions gives back the original');
  eq(text('del'), 'Revenue rose 12% this quarter.', 'dropping the removals gives the rewrite');
  ok(d.some((p) => p.op === 'same' && p.text.includes('12%')), 'and unchanged words are shown as unchanged');
}

section('making the call');
(async () => {
  let sent = null;
  class Fake {
    constructor(opts) { this.opts = opts; const self = this;
      this.beta = { messages: { create: async (p) => { sent = { p, opts: self.opts };
        return reply({ segments: ['A', 'B'] }); } } }; }
  }
  const out = await AI.rewrite(Fake, 'sk-ant-test', { segments: ['a', 'b'], instruction: 'x' });
  eq(out.segments.join('|'), 'A|B', 'the rewritten segments come back');
  eq(sent.opts.apiKey, 'sk-ant-test', 'with the user\'s own key');
  eq(sent.opts.dangerouslyAllowBrowser, true, 'and the SDK\'s browser switch on, as it must be here');

  let refused = null;
  await AI.rewrite(Fake, '', { segments: ['a'], instruction: 'x' }).catch((e) => { refused = e; });
  eq(refused && refused.code, 'no-key', 'no key: refused before anything is sent');

  section('errors, in words a person can act on');
  const res = new Response('{}', { status: 401 });
  const auth = new Anthropic.AuthenticationError(401, { error: { message: 'invalid x-api-key' } }, 'invalid x-api-key', res.headers);
  ok(/API key was not accepted/.test(AI.describeError(auth, Anthropic)), 'a bad key says so');
  const rate = new Anthropic.RateLimitError(429, {}, 'rate limited', res.headers);
  ok(/Too many requests/.test(AI.describeError(rate, Anthropic)), 'a rate limit says so');
  const conn = new Anthropic.APIConnectionError({ message: 'fetch failed' });
  ok(/Could not reach Anthropic/.test(AI.describeError(conn, Anthropic)), 'no connection says so');

  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + ' — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
