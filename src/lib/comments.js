/*
 * Quick Edit — comments.
 *
 * A comment is stored as an ordinary HTML comment sitting just before the block
 * it is attached to:
 *
 *     <!-- comment: needs a figure for Q3 -->
 *     <p>Revenue grew by 12% over the quarter.</p>
 *
 * Nothing about that is Quick Edit's private format. A browser shows none of
 * it, a text editor shows all of it, and anyone — or anything — you send the
 * file to can read it without knowing this extension exists. That is the whole
 * reason for choosing comments over a store inside the browser: notes that
 * cannot travel with the document are not much use.
 *
 * Writing one is the same zero-length splice that adding a block uses, so it
 * displaces nothing.
 */
(function (root) {
  'use strict';

  var Blocks = root.QuickEditBlocks;

  // Continuation lines are indented to sit under the text of the first line.
  var CONTINUATION = '     ';

  /*
   * The note inside a comment, or null if this is not one of ours.
   * Continuation lines are trimmed, since their indentation is only there to
   * make the file readable.
   */
  function textOf(data) {
    var match = /^\s*comment:\s*([\s\S]*)$/i.exec(data);
    if (!match) return null;
    return match[1]
      .split('\n')
      .map(function (line) { return line.trim(); })
      .join('\n')
      .replace(/\s+$/, '');
  }

  /*
   * Make a note safe to put inside an HTML comment.
   *
   * A comment ends at the first "-->", and a run of hyphens next to the closing
   * bracket can end it early, so runs of two or more hyphens are broken up with
   * spaces and a trailing hyphen gets one after it. Nothing else needs escaping:
   * "<", ">" and "&" are all ordinary characters inside a comment.
   */
  function sanitise(text) {
    return String(text)
      .replace(/\r\n?/g, '\n')
      .replace(/-{2,}/g, function (run) { return run.split('').join(' '); })
      .replace(/-$/, '- ');
  }

  function markup(text, indent, newline) {
    var lines = sanitise(text).split('\n');
    var body = lines.map(function (line, i) {
      return i === 0 ? line : indent + CONTINUATION + line;
    }).join(newline);
    return '<!-- comment: ' + body + ' -->';
  }

  /*
   * Where a new comment for `block` goes: immediately before its start tag,
   * with a newline and the block's own indent trailing so the block still
   * begins its own line.
   */
  function anchorFor(map, source, block) {
    var range = map.elements.get(block);
    if (!range || !range.startTag) return null;
    var indent = Blocks.indentOf(source, range.startTag.start);
    return {
      offset: range.startTag.start,
      before: '',
      after: Blocks.newlineOf(source) + indent,
      indent: indent,
    };
  }

  /*
   * The range to cut when a comment is deleted.
   *
   * If the comment has a line to itself, the whole line goes, blank line and
   * all. Otherwise only the comment itself is removed, leaving whatever shares
   * its line alone.
   */
  function deleteRange(source, token) {
    var lineStart = source.lastIndexOf('\n', token.start - 1) + 1;
    var lineEnd = source.indexOf('\n', token.end);
    var restOfLine = source.slice(token.end, lineEnd === -1 ? source.length : lineEnd);

    if (/^[ \t]*$/.test(source.slice(lineStart, token.start)) &&
        /^[ \t\r]*$/.test(restOfLine)) {
      return { start: lineStart, end: lineEnd === -1 ? source.length : lineEnd + 1 };
    }
    return { start: token.start, end: token.end };
  }

  root.QuickEditComments = {
    textOf: textOf,
    sanitise: sanitise,
    markup: markup,
    anchorFor: anchorFor,
    deleteRange: deleteRange,
  };
})(typeof self !== 'undefined' ? self : globalThis);
