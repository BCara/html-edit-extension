#!/usr/bin/env bash
#
# Build the promotional sites, each with the web app inside it.
#
# One codebase, one site per brand. Each brand's site is a folder of plain
# static files that goes to its own domain:
#
#   out/viberevise/   -> viberevise's domain
#   out/stetproof/    -> stetproof's domain
#
# with the landing page at / and the app at /app/. The brands are in
# sites/brands/; the copy that differs between them is in each brand.json.
#
#   ./build-sites.sh               every brand
#   ./build-sites.sh stetproof     just one (what a host's build step runs)
#
# On Cloudflare Pages (or Netlify), make one project per brand from this repo:
#   build command     ./build-sites.sh stetproof
#   output directory  out/stetproof
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "$#" -gt 0 ]; then BRANDS=("$@"); else BRANDS=($(ls "$DIR/sites/brands")); fi

for b in "${BRANDS[@]}"; do
  [ -f "$DIR/sites/brands/$b/brand.json" ] || { echo "build-sites.sh: no brand '$b'" >&2; exit 1; }
  OUT="$DIR/out/$b"
  echo "== $b"
  rm -rf "$OUT"
  # The app first, verified under its own brand, then the site around it.
  BRAND="$b" "$DIR/build-app.sh" "$OUT/app" | sed 's/^/  /'
  node "$DIR/sites/build-site.js" "$b" "$OUT"
done
