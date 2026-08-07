#!/usr/bin/env bash
#
# agentBrowser installer.
#
#   curl -fsSL https://raw.githubusercontent.com/ig-shadow-walker/agentBrowser/main/scripts/install.sh | bash
#
# Downloads the macOS binary, verifies its checksum, puts it on PATH, makes sure
# a Chromium is available, and registers it as an MCP server with Claude Code
# and Codex.
set -euo pipefail

REPO="${AGENTBROWSER_REPO:-ig-shadow-walker/agentBrowser}"
VERSION="${AGENTBROWSER_VERSION:-latest}"
INSTALL_DIR="${AGENTBROWSER_INSTALL_DIR:-$HOME/.local/bin}"
BIN_NAME="agentbrowser"

bold()  { printf '\033[1m%s\033[0m\n' "$1"; }
info()  { printf '  %s\n' "$1"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn()  { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()   { printf '\033[31mError:\033[0m %s\n' "$1" >&2; exit 1; }

bold "agentBrowser installer"
echo

# ---------------------------------------------------------------- preflight
[ "$(uname -s)" = "Darwin" ] || die "This build is macOS only (found $(uname -s))."

case "$(uname -m)" in
  arm64)  ARCH="darwin-arm64" ;;
  x86_64) ARCH="darwin-x64" ;;
  *)      die "Unsupported architecture: $(uname -m)" ;;
esac
ok "macOS $ARCH"

command -v curl >/dev/null 2>&1 || die "curl is required."

# ------------------------------------------------------------ resolve release
if [ "$VERSION" = "latest" ]; then
  info "Resolving latest release…"
  VERSION="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | grep '"tag_name"' | head -1 | sed -E 's/.*"tag_name" *: *"([^"]+)".*/\1/')"
  [ -n "$VERSION" ] || die "Could not resolve the latest release of $REPO. Set AGENTBROWSER_VERSION to install a specific tag."
fi
ok "Version $VERSION"

BASE_URL="https://github.com/$REPO/releases/download/$VERSION"
ASSET="$BIN_NAME-$ARCH"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# -------------------------------------------------------------- download
info "Downloading $ASSET…"
curl -fsSL --progress-bar -o "$TMP/$ASSET" "$BASE_URL/$ASSET" \
  || die "Download failed: $BASE_URL/$ASSET"

if curl -fsSL -o "$TMP/SHA256SUMS" "$BASE_URL/SHA256SUMS" 2>/dev/null; then
  expected="$(grep " $ASSET\$" "$TMP/SHA256SUMS" | awk '{print $1}' || true)"
  if [ -n "$expected" ]; then
    actual="$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')"
    [ "$expected" = "$actual" ] || die "Checksum mismatch for $ASSET (expected $expected, got $actual)."
    ok "Checksum verified"
  else
    warn "No checksum listed for $ASSET; skipping verification."
  fi
else
  warn "No SHA256SUMS published for $VERSION; skipping verification."
fi

# --------------------------------------------------------------- install
mkdir -p "$INSTALL_DIR"
TARGET="$INSTALL_DIR/$BIN_NAME"

if [ -e "$TARGET" ]; then
  info "Replacing existing $TARGET"
  "$TARGET" close >/dev/null 2>&1 || true
fi

install -m 755 "$TMP/$ASSET" "$TARGET"
# curl in a terminal usually does not quarantine, but strip it if present so
# Gatekeeper does not block this unsigned binary.
xattr -d com.apple.quarantine "$TARGET" >/dev/null 2>&1 || true
ok "Installed to $TARGET"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    warn "$INSTALL_DIR is not on your PATH."
    shell_rc="$HOME/.zshrc"; [ -n "${BASH_VERSION:-}" ] && shell_rc="$HOME/.bashrc"
    info "Add it with:"
    info "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> $shell_rc && exec \$SHELL"
    ;;
esac

# --------------------------------------------------------------- browser
echo
bold "Browser"
if "$TARGET" doctor 2>/dev/null | grep -qE '^  ✓ (bundled|chrome|msedge)'; then
  ok "A usable browser is already available"
else
  info "Downloading Chromium (~150MB)…"
  if "$TARGET" install-browser >/dev/null 2>&1; then
    ok "Chromium installed"
  elif command -v npx >/dev/null 2>&1; then
    # The binary's own downloader needs a helper process it cannot spawn when
    # compiled, so fall back to Playwright's npm CLI when Node is present.
    if npx --yes "playwright@1.62.1" install chromium >/dev/null 2>&1; then
      ok "Chromium installed via npx playwright"
    else
      warn "Could not install Chromium automatically."
    fi
  else
    warn "Could not install Chromium automatically."
  fi

  if ! "$TARGET" doctor 2>/dev/null | grep -qE '^  ✓ (bundled|chrome|msedge)'; then
    warn "No usable browser yet. Install Google Chrome, or run:"
    info "  npx playwright@1.62.1 install chromium"
  fi
fi

# ------------------------------------------------------------------- MCP
echo
bold "Registering with your agents"
"$TARGET" install-mcp || warn "MCP registration reported a problem; run '$BIN_NAME install-mcp' to retry."

# ----------------------------------------------------------------- summary
echo
bold "Done"
info "Try it:"
info "  $BIN_NAME navigate example.com"
info "  $BIN_NAME snapshot"
info "  $BIN_NAME close"
echo
info "Store a credential:"
info "  $BIN_NAME secrets set MY_APP_PASSWORD '…'"
echo
info "Restart Claude Code or Codex to pick up the MCP server."
