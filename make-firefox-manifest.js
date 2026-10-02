#!/usr/bin/env node
/*
 * The Firefox manifest, derived from the Chrome one.
 *
 * Kept as a transform rather than a second file on purpose: two manifests by
 * hand drift, and the one that drifts is always the one nobody is testing that
 * week. Everything here is a difference Firefox actually requires.
 */
const fs = require('fs');
const path = require('path');

const root = __dirname;
const raw = fs.readFileSync(path.join(root, 'manifest.json'), 'utf8');
// The Chrome manifest carries // comments explaining each permission. They are
// the most valuable thing in the file and JSON does not allow them, so Chrome's
// own parser tolerates them and ours strips them here.
const m = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));

/*
 * Chrome runs the background as a service worker. Firefox runs an event page,
 * which has no importScripts(), so its dependency is listed here instead and
 * loaded in order. background.js tolerates both.
 */
m.background = { scripts: ['src/lib/origins.js', 'src/background.js'] };

/*
 * AMO requires a stable extension id. Without one every upload looks like a
 * different add-on and updates do not chain.
 */
m.browser_specific_settings = {
  gecko: {
    id: 'viberevise@viberevise.app',
    // scripting.executeScript and optional_host_permissions in MV3 both
    // landed well before this; 115 is the current ESR floor.
    strict_min_version: '115.0',
  },
};

fs.writeFileSync(process.argv[2] || path.join(root, 'manifest.firefox.json'),
                 JSON.stringify(m, null, 2) + '\n');
