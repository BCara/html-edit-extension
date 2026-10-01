/*
 * Quick Edit — AI rewrites.
 *
 * Everything about asking Claude to rewrite a passage that does not involve a
 * page: which models are offered, what the request looks like, and how the
 * answer is checked before anything is allowed near the document. The
 * extension's service worker and the web app both load this, and neither
 * needs a DOM to use it.
 *
 * THE GUARANTEE HAS TO SURVIVE THIS
 * ---------------------------------
 * Quick Edit's promise is that only the words change. A naive AI feature would
 * break it on the first request: send a paragraph's HTML, get HTML back, and
 * the model reformats the markup along the way.
 *
 * So the model never sees markup and never returns any. A paragraph like
 *
 *     Revenue grew by <strong>12%</strong> over the quarter.
 *
 * is three runs of text to Quick Edit — "Revenue grew by ", "12%", " over the
 * quarter." — and those three are what is sent, as an ordered list of
 * segments. The same number come back, each is written into its own slot, and
 * the <strong> is exactly where it was because nothing ever asked the model
 * about it. Structured output keeps the reply to that shape; readResult()
 * refuses anything that is not.
 *
 * BRING YOUR OWN KEY
 * ------------------
 * The key belongs to the user and is sent only to Anthropic. In the extension
 * it never enters the page: the call is made from the service worker, where
 * nothing in the document can read it. That matters because an HTML file
 * written by an AI can contain script, and keystrokes typed into a page are
 * visible to that page's scripts.
 */
(function (root) {
  'use strict';

  /*
   * The models offered, best first. The default is the first; which one to use
   * is the user's call and their bill, so cheaper ones are listed rather than
   * chosen for them.
   *
   *   effort     accepts output_config.effort. Haiku 4.5 does not — sending it
   *              is an error there.
   *   fallbacks  accepts server-side fallbacks, so a request a safety
   *              classifier declines is re-run on the model Anthropic
   *              recommends for that case instead of simply failing.
   */
  var MODELS = [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5',
      note: 'Best rewrites. The default.', effort: true, fallbacks: true },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5',
      note: 'Nearly as good, about half the cost.', effort: true, fallbacks: true },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5',
      note: 'Cheapest and fastest. Plainer rewrites.', effort: false, fallbacks: false },
  ];
  var DEFAULT_MODEL = MODELS[0].id;

  function modelById(id) {
    for (var i = 0; i < MODELS.length; i++) if (MODELS[i].id === id) return MODELS[i];
    return MODELS[0];
  }

  // What the menu offers. "Keep every fact" is in the ones that could
  // otherwise lose a figure, because a shorter paragraph that has quietly
  // dropped a number is worse than no rewrite at all.
  var PRESETS = [
    { id: 'shorter', label: 'Shorter',
      instruction: 'Make it shorter. Keep the meaning, and keep every fact, figure and name.' },
    { id: 'clearer', label: 'Clearer',
      instruction: 'Make it clearer and easier to read. Keep the meaning, and keep every fact, figure and name.' },
    { id: 'grammar', label: 'Fix spelling and grammar',
      instruction: 'Correct spelling, grammar and punctuation only. Change nothing else.' },
    { id: 'formal', label: 'More formal',
      instruction: 'Make the tone more formal and professional. Keep the meaning and every fact.' },
    { id: 'friendly', label: 'Friendlier',
      instruction: 'Make the tone warmer and more approachable. Keep the meaning and every fact.' },
  ];

  var SYSTEM = [
    'You rewrite short passages inside an HTML document for someone polishing it.',
    '',
    'The passage arrives as an ordered list of segments. Each boundary between',
    'segments is a place where the formatting changes in the document — bold, a',
    'link, emphasis — and that formatting will be put back on whichever segment',
    'sits in that position. So return exactly as many segments as you were given,',
    'in the same order, rewritten so that each piece still reads sensibly with its',
    'formatting applied. A segment that should keep its words comes back unchanged.',
    '',
    'Segments are plain text. Never add HTML, Markdown or surrounding quotation',
    'marks. Keep the spaces at the start and end of a segment where they separate',
    'it from its neighbours. Follow the document\'s own language and spelling',
    'conventions, not your own. Text given as context is there so the rewrite fits',
    'what surrounds it; do not rewrite it.',
  ].join('\n');

  var SCHEMA = {
    type: 'object',
    properties: {
      segments: { type: 'array', items: { type: 'string' } },
    },
    required: ['segments'],
    additionalProperties: false,
  };

  // Context either side is for fit, not for rewriting, and it is capped: a
  // long document should not make every small edit cost more.
  var CONTEXT_CHARS = 1500;

  function clip(text, fromEnd) {
    text = String(text || '');
    if (text.length <= CONTEXT_CHARS) return text;
    return fromEnd ? text.slice(text.length - CONTEXT_CHARS) : text.slice(0, CONTEXT_CHARS);
  }

  /*
   * The request, as client.beta.messages.create() takes it.
   *
   *   segments     the runs of text to rewrite, in order
   *   instruction  what to do with them
   *   before       text just before the passage, for context
   *   after        text just after it
   *   model        a model id from MODELS
   */
  function buildParams(req) {
    var model = modelById(req.model);
    var payload = {
      instruction: String(req.instruction || '').trim(),
      segment_count: req.segments.length,
      segments: req.segments,
    };
    var before = clip(req.before, true);
    var after = clip(req.after, false);
    if (before) payload.context_before = before;
    if (after) payload.context_after = after;

    var params = {
      model: model.id,
      max_tokens: 16000,
      system: SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify(payload, null, 2) }],
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    };
    // A small rewrite does not need deep reasoning; low effort is quicker and
    // costs less, and the rewrite is shown for approval before it lands.
    if (model.effort) params.output_config.effort = 'low';
    if (model.fallbacks) {
      params.betas = ['server-side-fallback-2026-07-01'];
      params.fallbacks = 'default';
    }
    return params;
  }

  function AIError(code, message) {
    var err = new Error(message);
    err.code = code;
    return err;
  }

  /*
   * The rewritten segments, or an error that says what went wrong in words a
   * person can act on. Nothing that fails these checks reaches the document.
   */
  function readResult(response, expected) {
    if (!response || !response.content) {
      throw AIError('empty', 'Claude sent back an empty answer. Try again.');
    }
    if (response.stop_reason === 'refusal') {
      throw AIError('refusal', 'Claude declined to rewrite this passage.');
    }
    if (response.stop_reason === 'max_tokens') {
      throw AIError('truncated', 'The rewrite was cut off before it finished. Try a shorter passage.');
    }

    var text = null;
    for (var i = response.content.length - 1; i >= 0; i--) {
      if (response.content[i].type === 'text') { text = response.content[i].text; break; }
    }
    if (text === null) throw AIError('empty', 'Claude sent back no text. Try again.');

    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw AIError('shape', 'Claude\'s answer was not in the expected form. Try again.');
    }
    var segments = parsed && parsed.segments;
    if (!Array.isArray(segments) || segments.some(function (s) { return typeof s !== 'string'; })) {
      throw AIError('shape', 'Claude\'s answer was not in the expected form. Try again.');
    }
    // The one check that protects the markup: a different number of segments
    // means the formatting boundaries no longer line up with the text.
    if (segments.length !== expected) {
      throw AIError('shape', 'Claude changed how the passage is split up, which would move ' +
                    'its formatting. Nothing was changed. Try again.');
    }
    return { segments: segments, model: response.model };
  }

  /*
   * Turn an SDK error into a sentence. `Anthropic` is the SDK class, whose
   * typed error classes are checked most specific first.
   */
  function describeError(err, Anthropic) {
    if (err && err.code && !err.status) return err.message;      // one of ours
    if (Anthropic) {
      if (err instanceof Anthropic.AuthenticationError) {
        return 'That API key was not accepted. Check it in Quick Edit\'s settings.';
      }
      if (err instanceof Anthropic.PermissionDeniedError) {
        return 'That API key is not allowed to use this model. Try another in settings.';
      }
      if (err instanceof Anthropic.NotFoundError) {
        return 'That model is not available on this key. Try another in settings.';
      }
      if (err instanceof Anthropic.RateLimitError) {
        return 'Too many requests for now. Wait a moment and try again.';
      }
      if (err instanceof Anthropic.BadRequestError) {
        // Usually the account itself — no credit, say — and the API says so
        // better than a paraphrase would.
        return 'Anthropic refused the request: ' + (err.message || 'bad request');
      }
      if (err instanceof Anthropic.APIConnectionError) {
        return 'Could not reach Anthropic. Check the connection and try again.';
      }
      if (err instanceof Anthropic.APIError) {
        return 'Anthropic answered with an error (' + err.status + '). Try again shortly.';
      }
    }
    return 'The rewrite failed: ' + String((err && err.message) || err);
  }

  /*
   * Make the call. `Anthropic` is the SDK class, passed in rather than looked
   * up so this module works under importScripts and in a page alike.
   *
   * dangerouslyAllowBrowser is the SDK's switch for calling the API from a
   * browser. The danger it guards against is shipping *your* key to strangers;
   * here the key is the user's own, typed by them, sent only to Anthropic.
   */
  function rewrite(Anthropic, apiKey, req) {
    if (!apiKey) {
      return Promise.reject(AIError('no-key', 'Add your Anthropic API key in Quick Edit\'s settings first.'));
    }
    if (!req.segments || !req.segments.length) {
      return Promise.reject(AIError('nothing', 'Select some text to rewrite first.'));
    }
    var client = new Anthropic({ apiKey: apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
    return client.beta.messages.create(buildParams(req))
      .then(function (response) { return readResult(response, req.segments.length); });
  }

  /*
   * Word-level differences between two strings, as [{op, text}] with op one of
   * 'same', 'del', 'add'. For showing a proposed rewrite so the change can be
   * judged at a glance rather than by rereading both versions.
   *
   * A longest-common-subsequence over words and the spaces between them. The
   * passages are paragraphs, so the quadratic table is small; anything past a
   * few thousand tokens is simply shown as removed-then-added.
   */
  function diffWords(a, b) {
    var x = String(a).split(/(\s+)/).filter(function (t) { return t !== ''; });
    var y = String(b).split(/(\s+)/).filter(function (t) { return t !== ''; });
    if (x.length * y.length > 4000000) {
      return [{ op: 'del', text: String(a) }, { op: 'add', text: String(b) }];
    }
    var n = x.length, m = y.length;
    var table = [];
    for (var i = 0; i <= n; i++) table.push(new Uint32Array(m + 1));
    for (i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        table[i][j] = x[i] === y[j] ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    var out = [];
    function push(op, text) {
      var last = out[out.length - 1];
      if (last && last.op === op) last.text += text;
      else out.push({ op: op, text: text });
    }
    i = 0; j = 0;
    while (i < n && j < m) {
      if (x[i] === y[j]) { push('same', x[i]); i++; j++; }
      else if (table[i + 1][j] >= table[i][j + 1]) { push('del', x[i]); i++; }
      else { push('add', y[j]); j++; }
    }
    while (i < n) push('del', x[i++]);
    while (j < m) push('add', y[j++]);
    return out;
  }

  root.QuickEditAI = {
    diffWords: diffWords,
    MODELS: MODELS,
    DEFAULT_MODEL: DEFAULT_MODEL,
    PRESETS: PRESETS,
    modelById: modelById,
    buildParams: buildParams,
    readResult: readResult,
    describeError: describeError,
    rewrite: rewrite,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = root.QuickEditAI;
})(typeof self !== 'undefined' ? self : globalThis);
