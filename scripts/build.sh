#!/usr/bin/env bash
# Compiles agentBrowser into standalone macOS binaries.
#
# Bun embeds the JS runtime, so the result runs on a machine with no Node.js.
# Two wrinkles need handling:
#
#   * chromium-bidi is marked external — Playwright only requires it lazily for
#     the Firefox/WebKit BiDi transports, which we never use.
#   * playwright-core locates its own package.json and browsers.json relative to
#     __dirname, which Bun bakes in as the build machine's path. We build to an
#     intermediate bundle, redirect that lookup (scripts/patch-bundle.mjs), then
#     compile. src/runtime-shim.ts writes the embedded copies out at startup.
set -euo pipefail

cd "$(dirname "$0")/.."

OUT_DIR="build"
WORK_DIR="build/.work"
TARGETS=("darwin-arm64" "darwin-x64")

echo "==> Embedding Playwright metadata"
node scripts/gen-assets.mjs

echo "==> Typechecking"
npx tsc --noEmit

echo "==> Bundling"
rm -rf "$OUT_DIR"
mkdir -p "$WORK_DIR"

BUNDLE="$WORK_DIR/bundle.js"
npx bun build src/index.ts \
  --target=bun \
  --external chromium-bidi \
  --outfile "$BUNDLE" \
  >/dev/null

echo "==> Patching Playwright package root"
node scripts/patch-bundle.mjs "$BUNDLE"

echo "==> Compiling"
for target in "${TARGETS[@]}"; do
  output="$OUT_DIR/agentbrowser-$target"
  echo "  - $target"
  npx bun build "$BUNDLE" \
    --compile \
    --target="bun-$target" \
    --external chromium-bidi \
    --outfile "$output" \
    >/dev/null
  chmod +x "$output"
done

rm -rf "$WORK_DIR"

echo "==> Checksums"
( cd "$OUT_DIR" && shasum -a 256 agentbrowser-* > SHA256SUMS && cat SHA256SUMS )

echo
ls -lh "$OUT_DIR" | tail -n +2 | awk '{printf "  %-34s %s\n", $9, $5}'
echo
echo "Done. Binaries in $OUT_DIR/"
