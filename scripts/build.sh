#!/usr/bin/env bash
# Compiles agentBrowser into standalone macOS binaries.
#
# Bun embeds the JS runtime, so the resulting file runs on a machine with no
# Node.js installed. `chromium-bidi` is marked external because Playwright only
# requires it lazily for the Firefox/WebKit BiDi transports, which we never use
# — we drive Chromium over CDP.
set -euo pipefail

cd "$(dirname "$0")/.."

OUT_DIR="build"
BUN="npx bun"
TARGETS=("darwin-arm64" "darwin-x64")

echo "==> Typechecking"
npx tsc --noEmit

echo "==> Building"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

for target in "${TARGETS[@]}"; do
  output="$OUT_DIR/agentbrowser-$target"
  echo "  - $target"
  $BUN build src/index.ts \
    --compile \
    --target="bun-$target" \
    --external chromium-bidi \
    --outfile "$output" \
    >/dev/null
  chmod +x "$output"
done

echo "==> Checksums"
( cd "$OUT_DIR" && shasum -a 256 agentbrowser-* > SHA256SUMS && cat SHA256SUMS )

echo
ls -lh "$OUT_DIR" | tail -n +2 | awk '{printf "  %-34s %s\n", $9, $5}'
echo
echo "Done. Binaries in $OUT_DIR/"
