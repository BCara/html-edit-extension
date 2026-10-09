#!/usr/bin/env node
/*
 * Write one brand's promotional site around its already-built app.
 *
 *   node sites/build-site.js <brand slug> <out dir>
 *
 * <out dir>/app/ must already hold the app (build-sites.sh does that first).
 * This adds, beside it:
 *
 *   index.html     the landing page: pitch, features, AI modes, pricing, FAQ
 *   privacy.html   store/PRIVACY.md under this brand's name
 *   site.css       shared styles; the brand's colours go in each page's <head>
 *   _headers       caching rules for Cloudflare Pages and Netlify
 *
 * The copy that differs between brands lives in sites/brands/<slug>/brand.json.
 * The copy that does not (what AI may do, pricing, the FAQ about browsers and
 * privacy) is here, so a fact changes in one place for both.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const [, , slug, outArg] = process.argv;
if (!slug || !outArg) { console.error('usage: build-site.js <slug> <out dir>'); process.exit(2); }
const OUT = path.resolve(outArg);
const brand = JSON.parse(fs.readFileSync(path.join(__dirname, 'brands', slug, 'brand.json'), 'utf8'));
const S = brand.site;
const N = brand.name;

if (!fs.existsSync(path.join(OUT, 'app', 'index.html'))) {
  console.error('build-site.js: ' + OUT + '/app/ has no app in it; run build-sites.sh');
  process.exit(1);
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---- shared pieces ---------------------------------------------------------

function tokens() {
  const set = (c) => `--paper:${c.paper};--panel:${c.panel};--ink:${c.ink};--muted:${c.muted};--line:${c.line};` +
    `--accent:${c.accent};--accent2:${c.accent2};--accent-ink:${c.accentInk};--tint:${c.tint};`;
  return `<style>
:root{${set(brand.colours.light)}--font-display:${brand.fonts.display};--font-body:${brand.fonts.body};color-scheme:light dark;}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${set(brand.colours.dark)}}}
:root[data-theme="dark"]{${set(brand.colours.dark)}}
</style>`;
}

function head(title, description, canonicalPath) {
  return `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="https://${brand.domain}${canonicalPath}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:url" content="https://${brand.domain}${canonicalPath}">
<meta property="og:image" content="https://${brand.domain}/app/icons/icon512.png">
<meta name="theme-color" content="${brand.colours.light.paper}" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="${brand.colours.dark.paper}" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/app/icons/icon32.png" sizes="32x32">
<link rel="icon" href="/app/icons/icon192.png" sizes="192x192">
<link rel="apple-touch-icon" href="/app/icons/icon192.png">
<link rel="stylesheet" href="/site.css">
${tokens()}
</head>`;
}

function nav(onHome) {
  const h = onHome ? '' : '/';
  return `<header class="nav"><div class="wrap">
  <a class="logo" href="/"><img src="/app/icons/icon192.png" alt="" width="30" height="30">${esc(N)}</a>
  <nav class="nav-links" aria-label="Sections">
    <a href="${h}#features">Features</a><a href="${h}#ai">AI</a><a href="${h}#pricing">Pricing</a><a href="${h}#faq">FAQ</a>
  </nav>
  <a class="btn primary small" href="/app/">Open the app</a>
</div></header>`;
}

function extensionButton() {
  if (brand.chromeStoreUrl) {
    return `<a class="btn" href="${esc(brand.chromeStoreUrl)}" rel="noopener">Add to Chrome</a>`;
  }
  return `<span class="btn" aria-disabled="true" title="Not published yet">Chrome extension <span class="soon">Coming soon</span></span>`;
}

function footer() {
  return `<footer><div class="wrap">
  <span>© ${new Date().getFullYear()} ${esc(N)}</span>
  <a href="/app/">Web app</a>
  <a href="/privacy.html">Privacy</a>
  ${brand.contact ? `<a href="mailto:${esc(brand.contact)}">Contact</a>` : ''}
</div></footer>`;
}

// ---- the demo in the hero --------------------------------------------------

function demo() {
  if (S.demo === 'stet') {
    return `<div class="demo" role="img" aria-label="A document open in ${esc(N)}: a phrase the AI wanted to rewrite is kept, with its suggestion shown in the margin">
  <div class="demo-bar"><i></i><i></i><i></i><span>board-update.html</span></div>
  <div class="demo-body">
    <h4>Quarterly update</h4>
    <p>We finished the migration two weeks early and <span class="stet">under budget</span><span class="stet-mark">stet</span>, which frees the team to start on reporting in May.</p>
    <div class="margin-card">
      <span class="who">AI (claude) · suggestion</span>
      <span>“…and delivered significant cost efficiencies across the programme…”</span>
      <div class="row"><span class="chip">Copy</span><span class="tag">Read mode: AI can’t edit</span></div>
    </div>
    <div class="row" style="display:flex;gap:8px;flex-wrap:wrap"><span class="chip">✓ Kept as written</span><span class="chip">You have the final say</span></div>
  </div>
</div>`;
  }
  return `<div class="demo" role="img" aria-label="A document open in ${esc(N)} after an AI tool regenerated it: your edits are kept and the AI's changes are highlighted">
  <div class="demo-bar"><i></i><i></i><i></i><span>operating-plan.html</span></div>
  <div class="demo-body">
    <div class="notice"><b>The file changed outside ${esc(N)}.</b> 3 changes brought in · your 2 fixes kept</div>
    <h4>Operating plan, year one</h4>
    <p>We launch in <span class="mine">Brisbane and the Gold Coast</span><span class="tag">You · edited</span> with two staff and a contractor.</p>
    <p><span class="outside">Revenue comes from a monthly subscription, with a free tier for single properties.</span><span class="tag">Changed outside</span></p>
    <div class="row" style="display:flex;gap:8px;flex-wrap:wrap"><span class="chip">3 outside changes</span><span class="chip">✓ Mark reviewed</span></div>
  </div>
</div>`;
}

// ---- the landing page ------------------------------------------------------

function heroTitle() {
  const parts = S.heroTitle.split('<br>');
  if (parts.length < 2) return esc(S.heroTitle);
  return esc(parts[0]) + '<br><span class="accent">' + esc(parts.slice(1).join(' ')) + '</span>';
}

const PROVIDERS = 'Anthropic (Claude), OpenAI, OpenRouter, Google Gemini, or a model on your own computer';

const FAQ = [
  { q: 'Is my document uploaded anywhere?',
    a: `No. ${N} opens and edits your document in your browser. There are no ${N} servers to send it to. If you turn on AI, only the paragraphs you ask about go to the AI service you chose, when you press the button.` },
  { q: 'Which browsers does it work in?',
    a: `The web app runs in any modern browser. In Chrome or Edge on a computer, Save writes straight back to the file you opened. Other browsers give you the edited copy to save yourself.` },
  { q: 'What can’t it change?',
    a: `Layout, styles and images. ${N} changes words, and adds paragraphs, lists, tables, bold and italic like the ones already in the document. Pages built by JavaScript in the browser can’t be edited, because their text isn’t in the file.` },
  { q: 'Do I need AI to use it?',
    a: `No. Every editing feature works without AI. AI is off until you add your own key.` },
  { q: 'Which AI services can I use?',
    a: `${PROVIDERS}. You pay your provider directly for what you use; ${N} adds nothing on top.` },
  { q: 'When is the Chrome extension coming?',
    a: `We’re preparing it for the Chrome Web Store. When it’s published, the button on this page will take you to it. Until then, the web app works with files on your computer or on your own network.` },
];

function landing() {
  const faq = (S.faqExtra || []).concat(FAQ);
  return `${head(S.title, S.description, '/')}
<body>
${nav(true)}
<main>
<section class="hero"><div class="wrap">
  <div>
    <span class="eyebrow">${esc(S.eyebrow)}</span>
    <h1>${heroTitle()}</h1>
    <p class="lede">${esc(S.heroLede)}</p>
    <div class="ctas">
      <a class="btn primary" href="/app/">Open the web app — free</a>
      ${extensionButton()}
    </div>
    <p class="fine">Free during beta · No account · Your files stay in your browser</p>
  </div>
  ${demo()}
</div></section>

<section class="band alt"><div class="wrap">
  <div class="section-head"><h2>${esc(S.painsTitle)}</h2></div>
  <div class="grid three">
    ${S.pains.map((p) => `<div class="card pain"><h3>${esc(p.title)}</h3><p>${esc(p.body)}</p></div>`).join('\n    ')}
  </div>
</div></section>

<section class="band" id="features"><div class="wrap">
  <div class="section-head"><h2>${esc(S.featuresTitle)}</h2></div>
  <div class="grid three">
    ${S.features.map((f) => `<div class="card feature"><div class="ico" aria-hidden="true">${esc(f.icon)}</div><h3>${esc(f.title)}</h3><p>${esc(f.body)}</p></div>`).join('\n    ')}
  </div>
</div></section>

<section class="band alt"><div class="wrap">
  <div class="section-head"><h2>${esc(S.stepsTitle)}</h2></div>
  <div class="grid three steps">
    ${S.steps.map((s) => `<div class="card step"><h3>${esc(s.title)}</h3><p>${esc(s.body)}</p></div>`).join('\n    ')}
  </div>
</div></section>

<section class="band" id="ai"><div class="wrap">
  <div class="section-head">
    <h2>You decide what AI may do</h2>
    <p>AI is optional and off until you add your own key for ${PROVIDERS}. Whichever mode you choose, AI never changes your document on its own, and every change it’s part of is listed under its name.</p>
  </div>
  <div class="grid two">
    <div class="card mode">
      <span class="label">Default</span>
      <h3>Read</h3>
      <ul>
        <li>Explains a passage you select</li>
        <li>Reviews and proofreads the document</li>
        <li>Replies to comments</li>
        <li>Suggests rewrites you can copy</li>
        <li><b>Can’t change a word.</b> You make every edit yourself.</li>
      </ul>
    </div>
    <div class="card mode">
      <span class="label">Your choice</span>
      <h3>Read and write</h3>
      <ul>
        <li>Everything in Read</li>
        <li>Suggested rewrites get an <b>Accept</b> button</li>
        <li>Nothing is applied until you press it</li>
        <li>Each accepted change is labelled with the AI model and can be undone on its own</li>
      </ul>
    </div>
  </div>
</div></section>

<section class="band alt" id="pricing"><div class="wrap">
  <div class="section-head"><h2>Pricing</h2><p>${esc(N)} is free while it’s in beta.</p></div>
  <div class="price">
    <div class="card price-card">
      <h3>Beta</h3>
      <div class="amount">Free</div>
      <span class="per">while we’re in beta · no card, no account</span>
      <ul class="ticks">
        <li>The web app, with every editing feature</li>
        <li>Changes list, per-change undo and comments</li>
        <li>Outside-change detection and review</li>
        <li>AI with your own key, in Read or Read and write mode</li>
        <li>The Chrome extension, when it’s published</li>
      </ul>
      <a class="btn primary" href="/app/">Open the web app</a>
    </div>
    <div class="price-notes">
      <div><h3>Paid plans later</h3><p>When paid plans arrive, we’ll announce them here before anything changes.</p></div>
      <div><h3>Your files stay yours</h3><p>Everything you save is an ordinary HTML file on your own disk. Nothing is locked in.</p></div>
      <div><h3>AI costs</h3><p>You pay your AI provider directly for what you use, at their prices. ${esc(N)} adds nothing on top.</p></div>
    </div>
  </div>
</div></section>

<section class="band" id="faq"><div class="wrap">
  <div class="section-head"><h2>Questions</h2></div>
  <div class="faq">
    ${faq.map((f) => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('\n    ')}
  </div>
</div></section>

<section class="band alt closing"><div class="wrap">
  <h2>${esc(S.closingTitle)}</h2>
  <p>${esc(S.closingBody)}</p>
  <div class="ctas">
    <a class="btn primary" href="/app/">Open the web app — free</a>
    ${extensionButton()}
  </div>
</div></section>
</main>
${footer()}
</body>
</html>
`;
}

// ---- the privacy page ------------------------------------------------------

// Enough Markdown for PRIVACY.md: headings, paragraphs, bullet lists with
// wrapped lines, **bold**, *italic* and `code`.
function markdown(md) {
  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  }
  const out = [];
  let para = null, list = null;
  function flush() {
    if (para) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = null; }
    if (list) { out.push('<ul>' + list.map((li) => '<li>' + inline(li) + '</li>').join('') + '</ul>'); list = null; }
  }
  md.split('\n').forEach(function (line) {
    let m;
    if ((m = /^(#{1,3}) (.*)$/.exec(line))) { flush(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); }
    else if ((m = /^- (.*)$/.exec(line))) { if (para) flush(); list = list || []; list.push(m[1]); }
    else if (/^\s+\S/.test(line) && list) { list[list.length - 1] += ' ' + line.trim(); }
    else if (!line.trim()) { flush(); }
    else { if (list) flush(); para = para || []; para.push(line.trim()); }
  });
  flush();
  return out.join('\n');
}

function privacy() {
  let md = fs.readFileSync(path.join(ROOT, 'store', 'PRIVACY.md'), 'utf8').replace(/VibeRevise/g, N);
  const contact = brand.contact
    ? `Questions: [${brand.contact}](mailto:${brand.contact})`
    : 'A contact address will be published here before the extension launches.';
  md = md.replace(/^Questions: .*$/m, contact)
    .replace(/\[([^\]]+)\]\(mailto:[^)]+\)/g, '$1');
  md += `
## This website

This site sets no cookies and runs no analytics, and it loads nothing from anyone else: no web fonts, no trackers. Like any website, the service that hosts it may keep ordinary server logs, such as the addresses that requested pages.
`;
  return `${head(N + ' — privacy policy', 'What ' + N + ' does with your information: almost nothing.', '/privacy.html')}
<body>
${nav(false)}
<main class="wrap"><article class="prose">
${markdown(md)}
</article></main>
${footer()}
</body>
</html>
`;
}

// ---- write it --------------------------------------------------------------

fs.writeFileSync(path.join(OUT, 'index.html'), landing());
fs.writeFileSync(path.join(OUT, 'privacy.html'), privacy());
fs.copyFileSync(path.join(__dirname, 'site.css'), path.join(OUT, 'site.css'));
// The service worker must never be cached by the CDN, or an update never lands.
fs.writeFileSync(path.join(OUT, '_headers'), `/app/sw.js
  Cache-Control: no-cache
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
`);
console.log('  wrote the ' + N + ' site into ' + OUT);
