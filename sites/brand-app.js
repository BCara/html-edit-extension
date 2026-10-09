#!/usr/bin/env node
/*
 * Put a brand on a built copy of the web app.
 *
 * The product is one codebase sold under more than one name. build-app.sh
 * builds the app as VibeRevise, then calls this to swap in another brand:
 * every user-facing name, the manifest, the app's accent colours and the
 * icons. The engine itself is untouched.
 *
 * The rename is a plain textual swap across every file of the bundle, global
 * names included (window.VibeReviseEditor becomes window.StetProofEditor). It
 * is safe because it is applied to all of them at once, so every reference
 * still meets its definition, and the bundle's own test suite runs against
 * the result. The saved-file format carries no brand name (data-vr-*
 * attributes and ordinary HTML comments), so a file edited under one brand
 * opens cleanly under the other.
 *
 *   node sites/brand-app.js <brand.json> <built app dir>
 *   node sites/brand-app.js <brand.json> --files <file>...
 */
'use strict';

const fs = require('fs');
const path = require('path');

const [, , brandPath, ...rest] = process.argv;
if (!brandPath || !rest.length) {
  console.error('usage: brand-app.js <brand.json> <dir> | --files <file>...');
  process.exit(2);
}
const brand = JSON.parse(fs.readFileSync(brandPath, 'utf8'));
const brandDir = path.dirname(path.resolve(brandPath));

const camel = brand.name[0].toLowerCase() + brand.name.slice(1);
function rename(text) {
  return text
    .replace(/VibeRevise/g, brand.name)
    .replace(/vibeRevise/g, camel)
    .replace(/viberevise/g, brand.slug);
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(function (d) {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : [p];
  });
}
const TEXT = /\.(html|js|css|webmanifest|json)$/;

if (rest[0] === '--files') {
  rest.slice(1).forEach(function (f) { fs.writeFileSync(f, rename(fs.readFileSync(f, 'utf8'))); });
  process.exit(0);
}

const out = path.resolve(rest[0]);
walk(out).filter(function (f) { return TEXT.test(f); }).forEach(function (f) {
  fs.writeFileSync(f, rename(fs.readFileSync(f, 'utf8')));
});

// The manifest's long name and description belong to the brand, not to a rename.
const mPath = path.join(out, 'manifest.webmanifest');
const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
m.name = brand.appName;
m.short_name = brand.name;
m.description = brand.appDescription;
m.background_color = m.theme_color = brand.colours.light.paper;
fs.writeFileSync(mPath, JSON.stringify(m, null, 2) + '\n');

// Accent and paper colours. Appended, so the brand wins over the defaults.
const c = brand.colours;
fs.appendFileSync(path.join(out, 'app.css'), `
/* ---- brand: ${brand.name} (added by sites/brand-app.js) ---------------- */
:root { --paper: ${c.light.paper}; --ink: ${c.light.ink}; --muted: ${c.light.muted}; --line: ${c.light.line}; --accent: ${c.light.accent}; --accent-ink: ${c.light.accentInk}; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --paper: ${c.dark.paper}; --ink: ${c.dark.ink}; --muted: ${c.dark.muted}; --line: ${c.dark.line}; --accent: ${c.dark.accent}; --accent-ink: ${c.dark.accentInk}; }
}
.brand { font-family: ${brand.fonts.display}; color: inherit; text-decoration: none; }
`);

// On the brand's site the app lives at /app/, so its name leads home.
const iPath = path.join(out, 'index.html');
fs.writeFileSync(iPath, fs.readFileSync(iPath, 'utf8')
  .replace(/<div class="brand">([^<]*)<\/div>/, '<a class="brand" href="/" title="About $1">$1</a>')
  .replace(/(<meta name="theme-color" content=")[^"]*(" media="\(prefers-color-scheme: light\)">)/, '$1' + c.light.paper + '$2')
  .replace(/(<meta name="theme-color" content=")[^"]*(" media="\(prefers-color-scheme: dark\)">)/, '$1' + c.dark.paper + '$2'));

// Icons: the brand's own, if it has them, under the same file names.
const icons = path.join(brandDir, 'icons');
if (fs.existsSync(icons)) {
  fs.readdirSync(path.join(out, 'icons')).forEach(function (name) {
    const src = path.join(icons, name);
    if (!fs.existsSync(src)) throw new Error('brand ' + brand.slug + ' is missing icons/' + name);
    fs.copyFileSync(src, path.join(out, 'icons', name));
  });
}

console.log('  branded the app as ' + brand.name);
