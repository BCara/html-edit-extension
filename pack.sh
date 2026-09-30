#!/usr/bin/env bash
# Build the zip that goes to the Chrome Web Store.
#
# The repo carries tests, fixtures, a node package and a server route. None of
# that belongs in the extension the user installs, and the store counts it
# against the size limit and the review surface. This ships only what
# manifest.json actually loads.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$DIR/quick-edit-$(node -e "
  const fs=require('fs');
  const raw=fs.readFileSync('$DIR/manifest.json','utf8').replace(/^\s*\/\/.*\$/gm,'');
  process.stdout.write(JSON.parse(raw).version);
").zip"

# The skew detector compares src/content.js's VERSION against what a previous
# injection left behind, so it is useless if it does not track the manifest.
# These drifted apart once already; refuse to build a zip that repeats it.
MANIFEST_V="$(basename "$OUT" .zip | sed 's/^quick-edit-//')"
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
  -x '*/.*'

echo "wrote $OUT"
unzip -l "$OUT" | tail -n +4 | head -n -2 | awk '{print "  " $4}'
echo
echo "Check that list: every file the manifest loads should be there, and nothing else."
