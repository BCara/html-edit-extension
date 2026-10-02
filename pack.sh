#!/usr/bin/env bash
# Build the zips that go to the Chrome Web Store and to AMO.
#
# The repo carries tests, fixtures, a node package and a server route. None of
# that belongs in the extension the user installs, and the store counts it
# against the size limit and the review surface. This ships only what
# manifest.json actually loads.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$DIR/viberevise-$(node -e "
  const fs=require('fs');
  const raw=fs.readFileSync('$DIR/manifest.json','utf8').replace(/^\s*\/\/.*\$/gm,'');
  process.stdout.write(JSON.parse(raw).version);
").zip"

# The skew detector compares src/content.js's VERSION against what a previous
# injection left behind, so it is useless if it does not track the manifest.
# These drifted apart once already; refuse to build a zip that repeats it.
MANIFEST_V="$(basename "$OUT" .zip | sed 's/^viberevise-//')"
CONTENT_V="$(sed -n "s/.*var VERSION = '\([^']*\)'.*/\1/p" "$DIR/src/content.js")"
if [ "$MANIFEST_V" != "$CONTENT_V" ]; then
  echo "version mismatch: manifest.json is $MANIFEST_V, src/content.js is $CONTENT_V" >&2
  exit 1
fi

rm -f "$OUT"
cd "$DIR"

zip -r -q "$OUT" \
  manifest.json \
  icons \
  src \
  packages/html-splice/src \
  packages/html-splice/LICENSE \
  LICENSE \
  -x '*/.*' '*.test.js'

echo "wrote $OUT"
unzip -l "$OUT" | tail -n +4 | head -n -2 | awk '{print "  " $4}'

# --- Firefox -----------------------------------------------------------------
#
# Same files, different manifest. The differences are generated rather than
# maintained by hand — see make-firefox-manifest.js for what and why.
FFOUT="$DIR/viberevise-firefox-$MANIFEST_V.zip"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

unzip -q "$OUT" -d "$WORK"
node "$DIR/make-firefox-manifest.js" "$WORK/manifest.json"
rm -f "$FFOUT"
(cd "$WORK" && zip -r -q "$FFOUT" .)

# A Firefox build whose manifest still names a service worker would install and
# then do nothing, silently, because the background would never start.
node -e "
  const m = require('$WORK/manifest.json');
  if (m.background.service_worker) { console.error('firefox manifest still has service_worker'); process.exit(1); }
  if (!m.background.scripts || !m.background.scripts.length) { console.error('firefox manifest has no background scripts'); process.exit(1); }
  if (!m.browser_specific_settings) { console.error('firefox manifest has no gecko id'); process.exit(1); }
"
echo "wrote $FFOUT"
echo
echo "Check those lists: every file the manifest loads should be there, and nothing else."
