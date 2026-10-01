#!/usr/bin/env bash
#
# Build the deployable web app into dist/.
#
# app/ cannot be deployed as it stands: its script tags reach up and out of the
# directory, at ../src/ and ../packages/, because in the repo those are where
# the code lives and the extension needs them there. A static host serves a
# directory, not a repository, so the build copies what the app actually loads
# into one self-contained folder and rewrites the paths to match.
#
# The result is plain static files. There is no backend, nothing is uploaded,
# and it can go on any static host — which is the whole reason this can be an
# app without being a service.
#
#   ./build-app.sh            -> dist/
#   ./build-app.sh somewhere  -> somewhere/
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-$DIR/dist}"

rm -rf "$OUT"
mkdir -p "$OUT/lib" "$OUT/icons"

# The app's own files.
cp "$DIR/app/index.html" "$DIR/app/app.css" "$DIR/app/app.js" \
   "$DIR/app/sw.js" "$DIR/app/manifest.webmanifest" "$OUT/"

# Everything index.html loads, flattened into lib/. Order is irrelevant here —
# the script tags in index.html still decide that.
cp "$DIR/packages/html-splice/src/tokenizer.js" \
   "$DIR/packages/html-splice/src/splice.js" \
   "$DIR/src/lib/origins.js" \
   "$DIR/src/lib/mapping.js" \
   "$DIR/src/lib/islands.js" \
   "$DIR/src/lib/blocks.js" \
   "$DIR/src/lib/structures.js" \
   "$DIR/src/lib/ai.js" \
   "$DIR/src/vendor/anthropic-sdk.js" \
   "$DIR/src/lib/comments.js" \
   "$DIR/src/lib/prompt.js" \
   "$DIR/src/editor.js" \
   "$OUT/lib/"

cp "$DIR/icons/icon192.png" "$DIR/icons/icon512.png" \
   "$DIR/icons/icon512-maskable.png" "$OUT/icons/"

# Rewrite the paths the copies broke.
#   ../packages/html-splice/src/X.js -> lib/X.js
#   ../src/lib/X.js                  -> lib/X.js
#   ../src/editor.js                 -> lib/editor.js
#   ../icons/                        -> icons/
for f in "$OUT/index.html" "$OUT/sw.js" "$OUT/manifest.webmanifest"; do
  sed -i \
    -e 's|\.\./packages/html-splice/src/|lib/|g' \
    -e 's|\.\./src/lib/|lib/|g' \
    -e 's|\.\./src/vendor/|lib/|g' \
    -e 's|\.\./src/editor\.js|lib/editor.js|g' \
    -e 's|\.\./icons/|icons/|g' \
    "$f"
done

# Nothing may still point outside the bundle, or it will 404 on a static host.
if grep -rn '\.\./' "$OUT/index.html" "$OUT/sw.js" "$OUT/manifest.webmanifest"; then
  echo "build-app.sh: a path still escapes the bundle (above)" >&2
  exit 1
fi

# Every file the shell promises to cache has to exist, or the service worker's
# addAll() rejects and the app silently fails to install.
MISSING=0
while read -r ref; do
  [ -f "$OUT/$ref" ] || { echo "  missing from bundle: $ref" >&2; MISSING=1; }
done < <(sed -n "s/^  '\([^']*\)',$/\1/p" "$OUT/sw.js")
[ "$MISSING" -eq 0 ] || { echo "build-app.sh: service worker would fail to install" >&2; exit 1; }

# Verify the BUNDLE, not the repo: copy the app's own suite in, run it against
# the built files, then take it back out. A bundle whose paths are subtly wrong
# looks perfectly fine on disk and fails on the host.
if [ "${SKIP_VERIFY:-}" != "1" ]; then
  CHROME="${CHROME:-$(command -v google-chrome || command -v google-chrome-stable || command -v chromium || true)}"
  if [ -n "$CHROME" ]; then
    mkdir -p "$OUT/test"
    cp "$DIR/app/test/app-test.html" "$OUT/test/"
    cp "$DIR/test/report.js" "$OUT/test/"
    sed -i 's|\.\./\.\./test/report\.js|report.js|' "$OUT/test/app-test.html"

    VPORT=8477
    node -e '
const http=require("http"),fs=require("fs"),path=require("path");
const root=process.argv[1];
const T={".html":"text/html;charset=utf-8",".js":"text/javascript;charset=utf-8",".css":"text/css;charset=utf-8",".png":"image/png",".webmanifest":"application/manifest+json"};
http.createServer((req,res)=>{
  const f=path.join(root,decodeURIComponent(req.url.split("?")[0]));
  if(!f.startsWith(root)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);return res.end("no");}
  res.writeHead(200,{"Content-Type":T[path.extname(f)]||"application/octet-stream"});
  fs.createReadStream(f).pipe(res);
}).listen('"$VPORT"');
' "$OUT" &
    VPID=$!
    for _ in $(seq 1 50); do
      curl -sf -o /dev/null "http://127.0.0.1:$VPORT/index.html" && break
      sleep 0.2
    done

    VWORK="$(mktemp -d)"
    timeout 60 "$CHROME" --headless=new --disable-gpu --no-sandbox \
      --user-data-dir="$VWORK/p" --virtual-time-budget=20000 \
      --dump-dom "http://127.0.0.1:$VPORT/test/app-test.html" \
      > "$VWORK/dom.html" 2>/dev/null || true
    kill $VPID 2>/dev/null || true

    node "$DIR/test/extract-results.js" "$VWORK/dom.html" | sed 's/^/  /'
    STATUS="${PIPESTATUS[0]}"
    rm -rf "$VWORK" "$OUT/test"
    [ "$STATUS" -eq 0 ] || { echo "build-app.sh: the built bundle failed its own tests" >&2; exit 1; }
  else
    echo "  (no Chrome found — bundle not verified)"
  fi
fi

echo "built $OUT"
find "$OUT" -type f | sed "s|$OUT/|  |" | sort
echo
du -sh "$OUT" | sed 's/^/  total /'
