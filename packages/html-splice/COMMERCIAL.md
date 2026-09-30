# Commercial licensing

`html-text-splice` is released under the **AGPL-3.0**. That is a deliberate
choice, not an oversight: the library is free for anyone willing to release
their own source under the same terms, and licensable for anyone who is not.

## When you need a commercial licence

You need one if you want to ship this code inside a product whose source you do
not publish under the AGPL. In practice that means:

- embedding it in a commercial CMS, page builder, or documentation tool
- shipping it in a desktop or mobile application
- running it inside a hosted service your customers use over a network — the
  AGPL's network clause reaches this case even though you distribute no binary

You do **not** need one to evaluate it, to use it internally on your own
documents, to use it in a project that is itself AGPL, or to use it in academic
or personal work.

## What a commercial licence gives you

- A perpetual, non-exclusive right to use, modify and distribute the library in
  your own products, with no copyleft obligation.
- The right to sublicense it as part of your product to your own customers.
- Warranty of authorship, and indemnity for the code as delivered.

Pricing depends on how it is used — a single product, a product line, or an
OEM/redistribution arrangement. Perpetual licence, per product.

## Getting one

Email **cara.bertram@azzo.com.au** with:

1. The product it would go into, and roughly what it does.
2. Whether it ships to customers, runs as a hosted service, or both.
3. Rough scale — seats, installs, or requests per month.

A quote follows, usually within a few days.

## Provenance

The library was extracted from [Quick Edit](../../README.md), a browser
extension for editing HTML documents in place, where the byte-preservation
guarantee is the entire product. It is not a weekend experiment: the offset
arithmetic is covered by a test suite that checks byte-identical round trips
against real files, including a 1 MB document, on every change.
