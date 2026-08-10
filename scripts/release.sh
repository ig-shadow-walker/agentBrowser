#!/usr/bin/env bash
#
# Cuts a release from this machine.
#
#   bash scripts/release.sh 0.1.3
#
# This replaces the CI pipeline, and deliberately keeps the one property that
# actually mattered: the artifacts are built and tested in a CLEAN CHECKOUT,
# never in your working tree.
#
# That is not paranoia. Both broken releases so far came from exactly this gap —
# a binary that worked here and nowhere else, because the dev machine happened
# to have files a fresh `npm ci` does not produce. Building in a throwaway clone
# is the only way to catch that before users do.
#
# Nothing is pushed or published until every suite passes.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$PWD"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
info() { printf '  %s\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '\033[31mError:\033[0m %s\n' "$1" >&2; exit 1; }

VERSION="${1:-}"
[ -n "$VERSION" ] || die "Usage: bash scripts/release.sh <version>   e.g. 0.1.3"
VERSION="${VERSION#v}"
echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' || die "Version must look like 0.1.3 (got '$VERSION')."
TAG="v$VERSION"

echo
bold "  Releasing agentBrowser $TAG"
echo

# ------------------------------------------------------------------ preflight
bold "  Preflight"

command -v gh >/dev/null 2>&1 || die "The GitHub CLI (gh) is required. Install it, then run: gh auth login"
gh auth status >/dev/null 2>&1 || die "Not logged in to GitHub. Run: gh auth login"
ok "gh authenticated"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || die "On branch '$BRANCH'. Release from main."
ok "on main"

[ -z "$(git status --porcelain)" ] || die "Working tree is dirty. Commit or stash first:
$(git status --short)"
ok "working tree clean"

git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] \
  || die "Local main and origin/main differ. Push or pull first."
ok "in sync with origin/main"

if git rev-parse "$TAG" >/dev/null 2>&1 || git ls-remote --exit-code --tags origin "$TAG" >/dev/null 2>&1; then
  die "Tag $TAG already exists. Pick a new version, or delete it:
  git tag -d $TAG && git push origin :refs/tags/$TAG"
fi
ok "$TAG is free"

if gh release view "$TAG" >/dev/null 2>&1; then
  die "A release for $TAG already exists. Delete it first: gh release delete $TAG"
fi
ok "no existing release"

# --------------------------------------------------------------- bump version
echo
bold "  Version"

node -e '
const fs = require("fs");
const version = process.argv[1];
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.version = version;
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
const vt = fs.readFileSync("src/version.ts", "utf8")
  .replace(/(export const VERSION = ")[^"]+(")/, `$1${version}$2`);
fs.writeFileSync("src/version.ts", vt);
' "$VERSION"
ok "package.json and src/version.ts set to $VERSION"

git add package.json src/version.ts
if git diff --cached --quiet; then
  info "already at $VERSION, nothing to commit"
else
  git commit -q -m "Release v$VERSION"
  ok "committed version bump"
fi
SHA="$(git rev-parse HEAD)"

# --------------------------------------------------------------- clean build
echo
bold "  Clean-room build"
info "Building from a fresh clone, so your local node_modules cannot mask a bug."

CLEAN_DIR="$(mktemp -d)/agentbrowser-release"
cleanup() { rm -rf "$(dirname "$CLEAN_DIR")"; }
trap cleanup EXIT

git clone -q "$REPO_ROOT" "$CLEAN_DIR"
git -C "$CLEAN_DIR" checkout -q "$SHA"
ok "cloned at ${SHA:0:7}"

info "npm ci …"
( cd "$CLEAN_DIR" && npm ci --silent >/dev/null 2>&1 ) || die "npm ci failed in the clean clone."
ok "dependencies installed"

info "building …"
( cd "$CLEAN_DIR" && bash scripts/build.sh >/dev/null ) || die "Build failed in the clean clone.
Re-run it yourself to see why:  cd $CLEAN_DIR && bash scripts/build.sh"
ok "binaries built"

BUILT_VERSION="$("$CLEAN_DIR/build/agentbrowser-darwin-arm64" version)"
[ "$BUILT_VERSION" = "$VERSION" ] || die "Binary reports $BUILT_VERSION but releasing $VERSION."
ok "binary reports $BUILT_VERSION"

# ---------------------------------------------------------------------- tests
echo
bold "  Tests (against the artifacts being shipped)"

# Chromium must exist for the suites; the clean clone has its own node_modules.
( cd "$CLEAN_DIR" && npx playwright install chromium >/dev/null 2>&1 ) || true

run_suite() {
  local label="$1" file="$2"
  local result
  if result="$( cd "$CLEAN_DIR" && AGENTBROWSER_BIN="$CLEAN_DIR/build/agentbrowser-darwin-arm64" node "$file" 2>&1 )"; then
    ok "$label — $(echo "$result" | grep -E '^[0-9]+ passed' || echo 'passed')"
  else
    echo "$result" | tail -25
    die "$label FAILED. Nothing has been pushed or published."
  fi
}

run_suite "CLI"        test/smoke.mjs
run_suite "MCP"        test/mcp-smoke.mjs
run_suite "install"    test/install-smoke.mjs
run_suite "standalone" test/standalone-smoke.mjs

# -------------------------------------------------------------------- publish
echo
bold "  Publishing"

git tag -a "$TAG" -m "$TAG"
git push -q origin main
ok "pushed main"
git push -q origin "$TAG"
ok "pushed $TAG"

gh release create "$TAG" \
  "$CLEAN_DIR/build/agentbrowser-darwin-arm64" \
  "$CLEAN_DIR/build/agentbrowser-darwin-x64" \
  "$CLEAN_DIR/build/SHA256SUMS" \
  --title "$TAG" \
  --generate-notes \
  >/dev/null
ok "release published"

echo
bold "  Done"
info "$(gh release view "$TAG" --json url -q .url)"
echo
info "Verify the real install path:"
info "  agentbrowser uninstall"
info "  curl -fsSL https://raw.githubusercontent.com/ig-shadow-walker/agentBrowser/main/scripts/install.sh | bash"
echo
