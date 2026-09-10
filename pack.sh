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
