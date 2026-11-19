#!/usr/bin/env bash
# Check the published page against its source: read the commit the page names, rebuild that commit with its own build.sh, and
# compare every file the rebuild has with what the site serves, byte for byte.
# Usage: ./check-page.sh [SITE_URL]   (default https://swapmarket.github.io/sol2base/; the nsite's address works too)
# Needs git, curl, and this repository with that commit fetched; and Node with npm, since the build bundles the libraries
# from package-lock.json.
set -euo pipefail

site=${1:-https://swapmarket.github.io/sol2base/}
site=${site%/}/
repo=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

curl -fsSL -o "$work/index.html" "${site}index.html"
commit=$(grep -o 'id="commit" href="https://github.com/SwapMarket/sol2base/tree/[0-9a-f]\{40\}"' "$work/index.html" | grep -o '[0-9a-f]\{40\}' || true)
[ -n "$commit" ] || { echo "the page names no commit" >&2; exit 1; }
echo "the page says it is commit $commit"
git -C "$repo" rev-parse --verify -q "$commit^{commit}" >/dev/null || git -C "$repo" fetch -q origin
mkdir "$work/src"
git -C "$repo" archive "$commit" | tar -x -C "$work/src"
[ -x "$work/src/build.sh" ] || { echo "commit $commit has no build.sh, so this can't rebuild it" >&2; exit 1; }
(cd "$work/src" && ./build.sh "$commit" >/dev/null 2>&1) || { echo "the rebuild failed" >&2; exit 1; }

bad=0
while IFS= read -r -d '' f; do
  rel=${f#"$work/src/_site/"}
  if ! curl -fsSL -o "$work/live" "$site$rel"; then echo "MISSING $rel"; bad=1
  elif cmp -s "$work/live" "$f"; then echo "same    $rel"; else echo "DIFFERS $rel"; bad=1; fi
done < <(find "$work/src/_site" -type f -print0 | sort -z)

if [ "$bad" = 0 ]; then echo "the published page is exactly commit $commit, rebuilt here"; else echo "the published page is NOT what commit $commit builds" >&2; exit 1; fi
