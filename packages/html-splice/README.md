# html-text-splice

Edit the text of an HTML document without re-serialising it. Every byte you did
not change survives exactly as written.

```js
const { tokenize, replaceSpans } = require('html-text-splice');

const src = '<p class=lead>Hello</p>\n<p>Goodbye</p>\n';
const spans = tokenize(src);

replaceSpans(src, [{ span: spans[0], text: 'Good morning' }]);
// '<p class=lead>Good morning</p>\n<p>Goodbye</p>\n'
//      ^ unquoted attribute kept, newlines kept, nothing reflowed
```

## The problem

Every obvious way to change the words in an HTML file goes through a parser and
then serialises the tree back out. What comes back is the parser's idea of your
document:

| You wrote | You get back |
| --- | --- |
| `<p class=lead>` | `<p class="lead">` |
| `&#39;` | `'` |
| `<!-- build: 3 -->` | *(dropped)* |
| your indentation | the serialiser's |
| `<table><tr>` | `<table><tbody><tr>` |

For generated markup that is fine. For a file a person wrote, a template whose
exact bytes matter, or any document under review, it is not: the diff is
enormous and the real change is lost inside it.

## The approach

Never serialise. Record where each text run *lives* in the original string, as a
pair of character offsets, and write the new document by splicing replacements
into those ranges. Everything you did not address is copied through untouched.

Two guarantees, both pinned by the test suite against real files:

- `replaceSpans(src, [])` returns `src`, byte for byte, for any input.
- Rewriting every span with its own raw text is a no-op.

The tokenizer handles the parser behaviour that makes naive offset tracking
wrong: raw text and RCDATA elements that swallow their content, the newline
`<pre>` eats, `>` inside single-quoted attribute values, bare `<` in running
text, conditional comments, processing instructions, and the difference between
a doctype and a bogus comment.

## Performance

Linear, single pass, no tree:

```
1,000,467 chars, 46,730 spans — tokenize 38.6 ms, splice all 12.1 ms
```

## API

```js
scan(source)      // { spans, tags, comments } — all in source order
tokenize(source)  // just the text spans
readTag(source, i)

applyEdits(source, edits)        // [{start, end, replacement}] -> string
escapeText(text)
replacementFor(span, text)

replaceSpans(source, changes)    // [{span, text}] -> string
verify(source)                   // every span quotes the source at its offsets
```

TypeScript definitions are included.

### Pairing spans with a real tree

`tokenize()` tells you where text lives in the source. It deliberately does not
build a tree — building a second, subtly-different tree and trusting it is how
you end up rewriting someone's file. If you need to know which span belongs to
which node in a parsed document, walk the parser's output in document order
alongside these spans and **verify each pair before trusting it**. `scan()`
returns tag and comment positions for exactly that purpose.

## Known limits

- **UTF-8 only.** Offsets are JavaScript string units; both sides of an edit
  measure the same string, so astral-plane characters need no special handling,
  but a document in another encoding must be decoded first.
- **Entities inside an edited span are normalised.** A span originally written
  as `&#39;` comes back as `'` *if you edit it*. `&`, `<`, `>` and non-breaking
  spaces are always re-encoded. Spans you do not touch keep their bytes.
- **Text only.** This replaces the text of existing runs and inserts at
  offsets. It does not move, delete or restructure elements.
- **Foreign content and foster parenting** (SVG/MathML subtleties, text yanked
  out of a `<table>`) can put the source order and the DOM order out of step.
  Verification catches it; the affected nodes are simply not editable.

## Tests

```
node test/engine-test.js
```

They run against the published entry point, so the suite doubles as the worked
example: if you are evaluating this library, that file is the fastest way to see
what it promises and what it refuses to do.

## Licence

AGPL-3.0-only. If that does not suit your product, a commercial licence is
available — see [COMMERCIAL.md](COMMERCIAL.md).
