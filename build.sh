#!/usr/bin/env bash
# Build the site into _site/: bundle the libraries into vendor/, stamp the commit into index.html, and pin
# every script and stylesheet it loads with Subresource Integrity, so the browser refuses a file whose
# content doesn't match.
# Usage: ./build.sh [commit sha]   (without one, a local build stamped "dev"; serve _site/ to try it)
set -euo pipefail
sha=${1:-dev}

rm -rf _site
mkdir -p _site/vendor
cp index.html app.js solana.js base.js qr.js style.css icon.png logo.svg sw.js _site/

# Libraries: exactly what package-lock.json records (npm checks each package's hash); no install scripts.
npm ci --ignore-scripts --no-audit --no-fund
npx esbuild deps/viem.js deps/web3.js deps/sign-client.js deps/qrcode.js \
  --bundle --format=esm --platform=browser --target=es2020 --minify --legal-comments=none \
  --define:global=globalThis --define:process.env.NODE_ENV='"production"' --outdir=_site/vendor

sri() { echo "sha384-$(openssl dgst -sha384 -binary "_site/$1" | openssl base64 -A)"; }
sed -i "s/__COMMIT_SHORT__/${sha::7}/g; s/__COMMIT__/${sha}/g" _site/index.html
for f in app.js solana.js base.js qr.js style.css vendor/viem.js vendor/web3.js vendor/sign-client.js vendor/qrcode.js; do
  sed -i "s|__SRI_${f}__|$(sri "$f")|g" _site/index.html
done

# Every placeholder filled.
! grep -q '__COMMIT\|__SRI_' _site/index.html
