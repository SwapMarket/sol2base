#!/usr/bin/env bash
# Build the site into _site/: stamp the commit into index.html and pin every script and stylesheet it
# loads with Subresource Integrity, so the browser refuses a file whose content doesn't match.
# Usage: ./build.sh <commit sha>
set -euo pipefail
sha=${1:?commit sha}

rm -rf _site
mkdir _site
cp index.html app.js solana.js base.js style.css icon.png sw.js _site/

sri() { echo "sha384-$(openssl dgst -sha384 -binary "_site/$1" | openssl base64 -A)"; }
sed -i "s/__COMMIT_SHORT__/${sha::7}/g; s/__COMMIT__/${sha}/g" _site/index.html
for f in app.js solana.js base.js style.css; do
  sed -i "s|__SRI_${f}__|$(sri "$f")|g" _site/index.html
done

# Every placeholder filled.
! grep -q '__COMMIT\|__SRI_' _site/index.html
