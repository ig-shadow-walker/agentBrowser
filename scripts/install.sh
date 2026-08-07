#!/usr/bin/env bash
#
# agentBrowser installer.
#
#   curl -fsSL https://raw.githubusercontent.com/ig-shadow-walker/agentBrowser/main/scripts/install.sh | bash
#
# Downloads the right binary, verifies its checksum, and hands off to the
# binary's own installer — which places it on PATH, makes sure a browser is
# available, and connects it to Claude Code and Codex.
#
# Downloading with curl matters: unlike a browser, curl does not set the
# com.apple.quarantine attribute, so Gatekeeper does not block the unsigned
# binary. That is why this is the supported install path.
set -euo pipefail

REPO="${AGENTBROWSER_REPO:-ig-shadow-walker/agentBrowser}"
VERSION="${AGENTBROWSER_VERSION:-latest}"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
info() { printf '  %s\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
die()  { printf '\033[31mError:\033[0m %s\n' "$1" >&2; exit 1; }

echo
bold "  agentBrowser installer"
echo

# ---------------------------------------------------------------- preflight
[ "$(uname -s)" = "Darwin" ] || die "This build is macOS only (found $(uname -s))."
command -v curl >/dev/null 2>&1 || die "curl is required."

case "$(uname -m)" in
  arm64)  ARCH="darwin-arm64" ;;
  x86_64) ARCH="darwin-x64" ;;
  *)      die "Unsupported architecture: $(uname -m)" ;;
esac
ok "macOS $ARCH"

# ------------------------------------------------------------ resolve release
# AGENTBROWSER_BASE_URL points the installer at an alternative asset host. Used
# by the test suite to exercise this script without publishing a release.
if [ -n "${AGENTBROWSER_BASE_URL:-}" ]; then
  BASE_URL="$AGENTBROWSER_BASE_URL"
  ok "Source ${BASE_URL}"
else
  if [ "$VERSION" = "latest" ]; then
    VERSION="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
      | grep '"tag_name"' | head -1 | sed -E 's/.*"tag_name" *: *"([^"]+)".*/\1/')"
    [ -n "$VERSION" ] || die "Could not find a release of $REPO. Set AGENTBROWSER_VERSION to pick a specific tag."
  fi
  ok "Version $VERSION"
  BASE_URL="https://github.com/$REPO/releases/download/$VERSION"
fi
ASSET="agentbrowser-$ARCH"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ------------------------------------------------------------------ download
info "Downloading…"
curl -fsSL -o "$TMP/$ASSET" "$BASE_URL/$ASSET" || die "Download failed: $BASE_URL/$ASSET"

if curl -fsSL -o "$TMP/SHA256SUMS" "$BASE_URL/SHA256SUMS" 2>/dev/null; then
  expected="$(grep " $ASSET\$" "$TMP/SHA256SUMS" | awk '{print $1}' || true)"
  if [ -n "$expected" ]; then
    actual="$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')"
    [ "$expected" = "$actual" ] || die "Checksum mismatch (expected $expected, got $actual)."
    ok "Checksum verified"
  fi
fi

chmod +x "$TMP/$ASSET"

# --------------------------------------------------------------- hand off
# The binary owns the install logic so the shell script and the double-click
# path cannot drift apart. Give it the terminal when we have one, so it can ask
# about PATH even though this script arrived through a pipe.
# Testing `-r /dev/tty` is not enough: the file can be readable while the
# process has no controlling terminal, and the redirect then fails outright.
# Actually opening it is the only reliable check.
if { exec 3</dev/tty; } 2>/dev/null; then
  "$TMP/$ASSET" install <&3
  exec 3<&-
else
  "$TMP/$ASSET" install < /dev/null
fi
