/*
 * html-text-splice — edit the text of an HTML document without touching its
 * markup.
 *
 * The problem this solves
 * ----------------------
 * Every obvious way to "change the words in this HTML file" goes through a
 * parser and then serialises the tree back out. What comes back is the
 * parser's idea of your document: re-indented, attributes re-quoted, optional
 * tags materialised, comments dropped, entities rewritten. For generated
 * markup that is fine. For a file a person wrote, or a template whose exact
 * bytes matter (an HTML email, a signed document, anything under review), it
 * is unacceptable — the diff is enormous and the real change is lost in it.
 *
 * This library never serialises. It records where each text run *lives* in the
 * original string, as a pair of character offsets, and writes a new document by
 * splicing replacements into those ranges. Every byte you did not address is
 * copied through untouched.
 *
 *   const { tokenize, replaceSpans } = require('html-text-splice');
 *
 *   const src = '<p class=lead>Hello</p>\n<p>Goodbye</p>\n';
 *   const spans = tokenize(src);            // [ {start,end,raw:'Hello'}, ... ]
 *   const out = replaceSpans(src, [{ span: spans[0], text: 'Good morning' }]);
 *
 *   // '<p class=lead>Good morning</p>\n<p>Goodbye</p>\n'
 *   //      ^ unquoted attribute survives, newlines survive, nothing reflowed
 *
 * Two guarantees, both covered by the test suite:
 *   - replaceSpans(src, []) === src, for any input, byte for byte.
 *   - Rewriting every span with its own raw text is a no-op.
 *
 * Pairing spans with DOM nodes
 * ----------------------------
 * tokenize() tells you where text lives in the source. It does NOT build a
 * tree — building a second, subtly-different tree and trusting it is how you
 * end up rewriting someone's file. If you need to know which span corresponds
 * to which node in a parsed document, walk the real parser's output in
 * document order alongside these spans and verify each pair before trusting
 * it. scan() additionally returns tag and comment positions for that purpose.
 */
'use strict';

const tokenizer = require('./src/tokenizer.js');
const splice = require('./src/splice.js');

/*
 * replaceSpans(source, changes) -> string
 *
 * changes: [ { span, text } ] where `span` came from tokenize()/scan() on this
 * same `source`, and `text` is the new plain text for it.
 *
 * Handles the two transformations that have to happen on the way back in:
 * escaping (so typed "<" cannot become markup) and line endings (the DOM only
 * ever hands back "\n", so a CRLF file would silently become LF).
 *
 * Throws on overlapping or out-of-bounds ranges rather than producing a
 * plausible but wrong document.
 */
function replaceSpans(source, changes) {
  const edits = (changes || []).map((c) => ({
    start: c.span.start,
    end: c.span.end,
    replacement: splice.replacementFor(c.span, c.text),
  }));
  return splice.applyEdits(source, edits);
}

/*
 * verify(source) -> boolean
 *
 * Every span must quote the source at its own offsets. Cheap, and worth
 * running over untrusted input before you rely on the offsets for anything.
 */
function verify(source) {
  return tokenizer.tokenize(source).every(
    (s) => source.slice(s.start, s.end) === s.raw
  );
}

module.exports = {
  // Source -> character ranges.
  scan: tokenizer.scan,
  tokenize: tokenizer.tokenize,
  readTag: tokenizer.readTag,

  // Character ranges -> a new source string.
  applyEdits: splice.applyEdits,
  escapeText: splice.escapeText,
  replacementFor: splice.replacementFor,

  // The two together, which is what most callers want.
  replaceSpans,
  verify,
};
