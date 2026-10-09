#!/usr/bin/env bash
#
# Build each brand's site and commit it into that brand's own deploy repo.
#
# The source stays here, in one repo. Each site's built files go to a sibling
# repo holding nothing else, which is what gets deployed:
#
#   ../viberevise-site   <- out/viberevise/
#   ../stetproof-site    <- out/stetproof/
#
#   ./publish-sites.sh            build, commit and push every brand
#   ./publish-sites.sh stetproof  just one
#   NO_PUSH=1 ./publish-sites.sh  commit but don't push
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "$#" -gt 0 ]; then BRANDS=("$@"); else BRANDS=($(ls "$DIR/sites/brands")); fi
SRC="$(git -C "$DIR" rev-parse --short HEAD)"
DIRTY="$(git -C "$DIR" status --porcelain | head -1)"

"$DIR/build-sites.sh" "${BRANDS[@]}" | grep -E '==|VR-RESULT|wrote'

for b in "${BRANDS[@]}"; do
  REPO="$(dirname "$DIR")/$b-site"
  if [ ! -d "$REPO/.git" ]; then
    git init -q -b main "$REPO"
    # Commit as whoever commits the source.
    git -C "$REPO" config user.name "$(git -C "$DIR" config user.name)"
    git -C "$REPO" config user.email "$(git -C "$DIR" config user.email)"
    echo "  created $REPO"
  fi
  # Mirror the build, leaving .git and the repo's own README alone.
  rsync -a --delete --exclude .git --exclude README.md "$DIR/out/$b/" "$REPO/"
  [ -f "$REPO/README.md" ] || cat > "$REPO/README.md" <<README
# $b-site

The built website for $b: static files, ready to deploy as they are.
Landing page at \`/\`, privacy policy at \`/privacy.html\`, the web app at \`/app/\`.

Don't edit these files. They are generated from the html-edit-extension repo by
\`./publish-sites.sh\`, and the next publish overwrites them.
README
  git -C "$REPO" add -A
  if git -C "$REPO" diff --cached --quiet; then
    echo "  $b: no changes"
  else
    git -C "$REPO" commit -q -m "Build from html-edit-extension $SRC${DIRTY:+ (with uncommitted changes)}"
    echo "  $b: committed $(git -C "$REPO" rev-parse --short HEAD)"
  fi
  if [ -z "${NO_PUSH:-}" ] && git -C "$REPO" remote get-url origin >/dev/null 2>&1; then
    git -C "$REPO" push -q -u origin main && echo "  $b: pushed"
  fi
done
