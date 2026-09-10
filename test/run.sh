#!/usr/bin/env bash
# Runs the whole suite from the command line.
#   node tests   — tokenizer + splice, no DOM needed
#   browser tests — the real HTML parser, in headless Chrome
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHROME="${CHROME:-$(command -v google-chrome || command -v google-chrome-stable || command -v chromium)}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "== node: origins and the write-back probe =="
node "$DIR/src/lib/origins.test.js" || NODE_FAIL=1

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

  node "$DIR/test/extract-results.js" "$dom"
  local status=$?

  if [ "$status" -eq 2 ]; then
    cp "$dom" "/tmp/quick-edit-$(basename "$page").html" 2>/dev/null
    echo "TESTS DID NOT REPORT — DOM dump copied to /tmp/quick-edit-$(basename "$page").html"
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

echo
if [ -n "${BROWSER_FAIL:-}" ] || [ -n "${NODE_FAIL:-}" ]; then
  echo "SUITE FAILED"
  exit 1
fi
echo "SUITE PASSED"
exit 0
