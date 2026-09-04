/*
 * Quick Edit — editable islands.
 *
 * Each editable text node is wrapped in its own <span contenteditable>, so a
 * region of text is exactly one source span and one editing surface. The
 * browser cannot merge, split or delete markup across an island boundary,
 * which is what makes "editing the text cannot disturb the tags" true by
 * construction rather than by vigilance.
 *
 * These wrappers live only in the page's DOM. They are never serialised: the
 * file is written by splicing the original source string, so nothing here can
 * reach it.
 *
 * ISLAND VALUES
 * -------------
 * An island holds text and, if the user pressed Enter, <br> elements. Its value
 * is flattened to a plain string with U+0001 standing in for each <br>, which
 * makes comparison, history and serialisation trivial. U+0001 is stripped from
 * anything pasted in, so it can never occur in real content.
 */
(function (root) {
  'use strict';

  var BR = '\u0001';
  var ATTR = 'data-qe-island';

  function wrap(node) {
    var span = node.ownerDocument.createElement('span');
    span.setAttribute(ATTR, '');
    node.parentNode.insertBefore(span, node);
    span.appendChild(node);
    return span;
  }

  /*
   * Put the island's children back where the island was and remove it.
   * The original text node object is moved, not cloned, so a map record still
   * points at the right node afterwards. normalize() is deliberately never
   * called: merging adjacent text nodes would collapse two source spans into
   * one node and invalidate the map.
   */
  function unwrap(span) {
    var parent = span.parentNode;
    if (!parent) return;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
  }

  function readValue(el) {
    var out = '';
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) out += n.data;
      else if (n.nodeType === 1 && n.tagName === 'BR') out += BR;
      else if (n.nodeType === 1) out += n.textContent;  // defensive: paste that slipped through
    }
    return out;
  }

  function writeValue(el, value) {
    var doc = el.ownerDocument;
    while (el.firstChild) el.removeChild(el.firstChild);
    var pieces = value.split(BR);
    for (var i = 0; i < pieces.length; i++) {
      if (i) el.appendChild(doc.createElement('br'));
      if (pieces[i]) el.appendChild(doc.createTextNode(pieces[i]));
    }
  }

  // True when the island contains nothing but text and <br> — i.e. nothing the
  // browser or a paste sneaked in behind our back.
  function isClean(el) {
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) continue;
      if (n.nodeType === 1 && n.tagName === 'BR') continue;
      return false;
    }
    return true;
  }

  // Length of a child node in island-value terms.
  function lengthOf(node) {
    return node.nodeType === 3 ? node.data.length : 1;
  }

  /*
   * Where the caret is, as an index into the island's flattened value.
   * Returns null when the selection is not inside this island.
   */
  function caretIndex(el) {
    var sel = el.ownerDocument.getSelection();
    if (!sel || !sel.rangeCount) return null;
    var range = sel.getRangeAt(0);
    if (!el.contains(range.endContainer)) return null;

    var idx = 0;
    var n;

    // Selection anchored on the island itself: the offset counts child nodes.
    if (range.endContainer === el) {
      var stop = range.endOffset;
      var i = 0;
      for (n = el.firstChild; n && i < stop; n = n.nextSibling, i++) idx += lengthOf(n);
      return idx;
    }

    for (n = el.firstChild; n; n = n.nextSibling) {
      if (n === range.endContainer) return idx + range.endOffset;
      if (n.contains && n.contains(range.endContainer)) return idx;
      idx += lengthOf(n);
    }
    return idx;
  }

  // Put the caret at `index` in the island's flattened value, clamped to fit.
  function setCaret(el, index) {
    var doc = el.ownerDocument;
    var sel = doc.getSelection();
    var range = doc.createRange();
    var idx = 0;

    for (var n = el.firstChild; n; n = n.nextSibling) {
      var len = lengthOf(n);
      if (index <= idx + len) {
        if (n.nodeType === 3) range.setStart(n, Math.max(0, index - idx));
        else if (index <= idx) range.setStartBefore(n);
        else range.setStartAfter(n);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      idx += len;
    }

    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  root.QuickEditIslands = {
    BR: BR,
    ATTR: ATTR,
    wrap: wrap,
    unwrap: unwrap,
    readValue: readValue,
    writeValue: writeValue,
    isClean: isClean,
    caretIndex: caretIndex,
    setCaret: setCaret,
  };
})(typeof self !== 'undefined' ? self : globalThis);
