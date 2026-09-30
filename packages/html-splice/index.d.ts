/*
 * Type definitions for html-text-splice.
 *
 * All offsets are character offsets into the ORIGINAL source string, in
 * JavaScript string units (UTF-16 code units). Both sides of an edit are
 * measured against the same string, so astral-plane characters need no special
 * handling — see the offset tests.
 */

/** A run of text in the source that the HTML parser will turn into a text node. */
export interface Span {
  /** Offset of the first character of the run. */
  start: number;
  /** Offset just past the last character of the run. */
  end: number;
  /** The exact original characters: `source.slice(start, end)`. */
  raw: string;
  /**
   * Drives character-reference decoding.
   * `rawtext` is <script>/<style>/... (references NOT decoded),
   * `rcdata` is <title>/<textarea> (references decoded).
   */
  kind: 'text' | 'rawtext' | 'rcdata';
  /**
   * A newline the parser discarded just before this span, for <pre>,
   * <textarea> and <listing>. It lives OUTSIDE [start, end) and is never
   * spliced, so it stays put in the source.
   */
  eaten: string;
}

/** A start or end tag, as raw source positions. Nothing is inferred about nesting. */
export interface Tag {
  start: number;
  end: number;
  /** Lower-cased tag name. */
  name: string;
  /** True for `</p>`, false for `<p>`. */
  isEnd: boolean;
}

/** A comment node's position and content. */
export interface Comment {
  start: number;
  end: number;
  /** The text between the delimiters. */
  data: string;
  /**
   * True for constructs that are not written as comments but which the parser
   * turns into comment nodes anyway: `<![if !IE]>`, `<?php ... ?>`, `</3>`.
   * Recorded so the sequence lines up with the DOM; skip them otherwise.
   */
  bogus: boolean;
}

export interface ScanResult {
  spans: Span[];
  tags: Tag[];
  comments: Comment[];
}

/** One text replacement, addressed by a span from this same source. */
export interface SpanChange {
  span: Span;
  /** The new plain text. Escaping and line endings are handled for you. */
  text: string;
}

/** A raw range replacement, addressed by offsets into the original source. */
export interface Edit {
  start: number;
  end: number;
  /** Written through verbatim — already escaped, if it needed to be. */
  replacement: string;
}

/** Spans, tags and comments, all in source order. */
export function scan(source: string): ScanResult;

/** Just the text spans — by far the most common thing to want. */
export function tokenize(source: string): Span[];

/** Read one tag starting at `i`, which must point at a `<`. */
export function readTag(source: string, i: number): Tag;

/**
 * The original source with the given ranges replaced.
 * An empty edit list returns the source unchanged, byte for byte.
 * Throws on overlapping or out-of-bounds ranges.
 */
export function applyEdits(source: string, edits: Edit[]): string;

/** Minimally escape text for insertion into element content. */
export function escapeText(text: string): string;

/** The exact string to splice in for `span` when its text is now `text`. */
export function replacementFor(span: Pick<Span, 'raw'>, text: string): string;

/** tokenize + applyEdits, with escaping and line endings handled. */
export function replaceSpans(source: string, changes: SpanChange[]): string;

/** Check that every span quotes the source at its own offsets. */
export function verify(source: string): boolean;
