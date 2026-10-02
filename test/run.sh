#!/usr/bin/env bash
# Runs the whole suite from the command line.
#   node tests   — tokenizer + splice, no DOM needed
#   browser tests — the real HTML parser, in headless Chrome
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHROME="${CHROME:-$(command -v google-chrome || command -v google-chrome-stable || command -v chromium)}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "== node: AI rewrites (no network) =="

echo
echo "== node: origins and the write-back probe =="
node "$DIR/src/lib/origins.test.js" || NODE_FAIL=1
node "$DIR/src/lib/prompt.test.js" || NODE_FAIL=1

echo
echo "== node: tokenizer + splice =="
node "$DIR/test/node-test.js" || NODE_FAIL=1

echo
echo "== node: the engine as a standalone package =="
node "$DIR/packages/html-splice/test/engine-test.js" || NODE_FAIL=1

echo
echo "== node: save-in-place route =="
node "$DIR/server/test-save.js" || NODE_FAIL=1

echo
echo "== generating the ~1MB fixtures =="
node "$DIR/test/make-large.js"
node "$DIR/packages/html-splice/test/make-large.js"

if [ -z "$CHROME" ]; then
  echo
  echo "  SKIP — no Chrome binary found (set CHROME=/path/to/chrome)"
  exit "${NODE_FAIL:-0}"
fi

# Runs one test page in headless Chrome and prints its results.
#
# --allow-file-access-from-files lets the harnesses fetch() their fixtures and
# read the iframes they load them into. It is a test-only flag; the extension
# itself relies on the user's "Allow access to file URLs" toggle instead.
# $3, if given, is passed to Chrome. Pages that need to fetch fixtures get
# --allow-file-access-from-files; file-read-test.html deliberately does NOT,
# because it is checking what a normal browser refuses to do.
run_page() {
  local page="$1"
  local title="$2"
  local extra="${3:-}"
  local dom="$WORK/$(basename "$page").dom.html"

  echo
  echo "== headless Chrome: $title =="

  "$CHROME" \
    --headless=new \
    --disable-gpu \
    --no-sandbox \
    $extra \
    --user-data-dir="$WORK/profile" \
    --virtual-time-budget=30000 \
    --dump-dom "file://$DIR/test/$page" > "$dom" 2>"$WORK/chrome.log"

  node "$DIR/test/extract-results.js" "$dom" "test/$page"
  local status=$?

  if [ "$status" -eq 2 ]; then
    cp "$dom" "/tmp/viberevise-$(basename "$page").html" 2>/dev/null
    echo "TESTS DID NOT REPORT — DOM dump copied to /tmp/viberevise-$(basename "$page").html"
    echo "--- chrome stderr ---"
    tail -20 "$WORK/chrome.log"
    return 1
  fi
  return "$status"
}

FLAG=--allow-file-access-from-files
run_page mapping-test.html "offset mapping" "$FLAG" || BROWSER_FAIL=1
run_page editor-test.html "edit mode, end to end" "$FLAG" || BROWSER_FAIL=1
# No flag here, on purpose. See the comment in the page.
run_page file-read-test.html "file read constraints (no flag)" || BROWSER_FAIL=1

# The web app has to be served: it loads its own index.html in a frame, and
# file:// frames are not same-origin with their parent.
echo
echo "== headless Chrome: the web app =="
PORT=8455
node -e '
const http=require("http"),fs=require("fs"),path=require("path");
const root=process.argv[1];
const T={".html":"text/html;charset=utf-8",".js":"text/javascript;charset=utf-8",".css":"text/css;charset=utf-8"};
http.createServer((req,res)=>{
  const f=path.join(root,decodeURIComponent(req.url.split("?")[0]));
  if(!f.startsWith(root)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);return res.end("no");}
  res.writeHead(200,{"Content-Type":T[path.extname(f)]||"application/octet-stream"});
  fs.createReadStream(f).pipe(res);
}).listen('"$PORT"');
' "$DIR" &
SERVER_PID=$!

# Wait for it to actually answer rather than guessing at a second. A fixed
# sleep made this suite fail intermittently, which is worse than not having it.
for _ in $(seq 1 50); do
  if curl -sf -o /dev/null "http://127.0.0.1:$PORT/app/index.html"; then break; fi
  sleep 0.2
done

# Chrome does not exit on its own against a live server, so it is given a
# deadline; the DOM it dumped before the deadline is what we read.
timeout 60 "$CHROME" --headless=new --disable-gpu --no-sandbox \
  --user-data-dir="$WORK/appprofile" --virtual-time-budget=20000 \
  --dump-dom "http://127.0.0.1:$PORT/app/test/app-test.html" \
  > "$WORK/app.dom.html" 2>"$WORK/app.log" || true
kill $SERVER_PID 2>/dev/null || true

node "$DIR/test/extract-results.js" "$WORK/app.dom.html" "app/test/app-test.html" || APP_FAIL=1

echo
if [ -n "${BROWSER_FAIL:-}" ] || [ -n "${NODE_FAIL:-}" ] || [ -n "${APP_FAIL:-}" ]; then
  echo "SUITE FAILED"
  exit 1
fi
echo "SUITE PASSED"
exit 0
