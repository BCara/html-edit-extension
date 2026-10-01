#!/usr/bin/env bash
# Rebuild src/vendor/anthropic-sdk.js from the official Anthropic TypeScript SDK.
#
# Why vendored rather than loaded: a Manifest V3 extension may not load remote
# code, and this project has no build step of its own. So the SDK is bundled
# once, here, into a single file both hosts can load — importScripts() in the
# extension's service worker, a script tag in the web app — and checked in.
#
# The bundle must contain no eval and no new Function: MV3's content security
# policy refuses both, and the failure is a blank service worker rather than a
# clear error. This script refuses to write one that does.
#
#   ./scripts/vendor-sdk.sh            latest release
#   ./scripts/vendor-sdk.sh 0.131.0    a specific version
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:-latest}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
npm init -y >/dev/null
npm install --silent "@anthropic-ai/sdk@$VERSION" esbuild

cat > entry.js <<'JS'
import Anthropic from '@anthropic-ai/sdk';
export { Anthropic };
JS

npx esbuild entry.js --bundle --format=iife --global-name=QuickEditAnthropicSDK \
  --platform=browser --target=es2020 --minify --legal-comments=eof \
  --outfile=anthropic-sdk.js

if grep -q 'eval(' anthropic-sdk.js || grep -q 'new Function' anthropic-sdk.js; then
  echo "vendor-sdk.sh: the bundle uses eval or new Function; MV3 would refuse it" >&2
  exit 1
fi

INSTALLED="$(node -p "require('./node_modules/@anthropic-ai/sdk/package.json').version")"
cp anthropic-sdk.js "$DIR/src/vendor/anthropic-sdk.js"
cp node_modules/@anthropic-ai/sdk/LICENSE "$DIR/src/vendor/anthropic-sdk.LICENSE"
echo "$INSTALLED" > "$DIR/src/vendor/anthropic-sdk.VERSION"
echo "vendored @anthropic-ai/sdk $INSTALLED ($(wc -c < anthropic-sdk.js) bytes)"
