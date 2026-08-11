#!/usr/bin/env bash
#
# Builds a signed, notarized, stapled agentBrowser.app and .dmg.
#
#   bash app/scripts/sign-and-notarize.sh          full build + notarize
#   bash app/scripts/sign-and-notarize.sh verify   re-check existing artifacts
#
# Use `verify` rather than re-running the build to inspect a finished bundle:
# every full run uploads a fresh submission to Apple, and submissions cannot be
# cancelled once queued.
#
# Credentials come from app/.signing.env (gitignored). Nothing secret is
# hardcoded and nothing is printed.
set -euo pipefail

cd "$(dirname "$0")/.."          # app/
APP_DIR="$PWD"
REPO_ROOT="$(dirname "$APP_DIR")"
APP="$APP_DIR/src-tauri/target/release/bundle/macos/agentBrowser.app"
MODE="${1:-build}"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
info() { printf '  %s\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '\033[31mError:\033[0m %s\n' "$1" >&2; exit 1; }

verify_bundle() {
  local app="$1"
  [ -d "$app" ] || die "No app bundle at $app. Build it first."

  # Captured once, then inspected. Piping codesign into `grep -q` under
  # `set -o pipefail` is unreliable — grep exits on first match and the
  # resulting SIGPIPE can surface as a pipeline failure, which once reported a
  # perfectly good notarized build as broken.
  local signature
  signature="$(codesign -dv --verbose=2 "$app" 2>&1 || true)"

  info "signature:"
  printf '%s\n' "$signature" | grep -E 'Authority|TeamIdentifier|flags' | sed 's/^/    /'

  # Stapling is the authoritative signal: Apple only issues a ticket for a build
  # it accepted, and it rejects anything lacking the hardened runtime. So this is
  # checked first and the flag below is informational.
  info "notarization ticket:"
  if xcrun stapler validate "$app" >/dev/null 2>&1; then
    ok "stapled — Apple accepted this build"
  else
    die "No notarization ticket stapled to $app"
  fi

  if printf '%s\n' "$signature" | grep -q 'flags=.*runtime'; then
    ok "hardened runtime enabled"
  else
    info "note: could not read the runtime flag (the ticket stapled, so it is on)"
  fi

  info "deep signature check:"
  codesign --verify --deep --strict --verbose=2 "$app" 2>&1 | tail -2 | sed 's/^/    /'

  info "the bundled engine is signed too:"
  codesign -dv "$app/Contents/MacOS/agentbrowser" 2>&1 \
    | grep -E 'Authority=Developer|Signature' | sed 's/^/    /'

  info "Gatekeeper assessment:"
  spctl -a -vvv -t exec "$app" 2>&1 | sed 's/^/    /'

  local dmg
  dmg="$(ls -t "$APP_DIR/src-tauri/target/release/bundle/dmg/"*.dmg 2>/dev/null | head -1 || true)"
  if [ -n "$dmg" ]; then
    info "dmg, as a user receives it:"
    codesign -dv "$dmg" 2>&1 | grep -E 'Authority=Developer' | sed 's/^/    /' || true
    spctl -a -vvv -t install "$dmg" 2>&1 | sed 's/^/    /' || true
  fi
}

latest_dmg() {
  ls -t "$APP_DIR/src-tauri/target/release/bundle/dmg/"*.dmg 2>/dev/null | head -1 || true
}

# Tauri notarizes and staples the .app, then signs the .dmg around it — but does
# not notarize the disk image itself. A signed-but-unnotarized DMG is rejected by
# Gatekeeper once it carries a download quarantine flag, so the app inside being
# notarized is not enough. The image has to be notarized and stapled too.
notarize_dmg() {
  local dmg
  dmg="$(latest_dmg)"
  [ -n "$dmg" ] || die "No .dmg found to notarize."

  if xcrun stapler validate "$dmg" >/dev/null 2>&1; then
    ok "dmg already stapled — nothing to do"
    return 0
  fi

  info "submitting $(basename "$dmg") …"
  xcrun notarytool submit "$dmg" \
    --apple-id "$APPLE_ID" \
    --team-id "$APPLE_TEAM_ID" \
    --password "$APPLE_PASSWORD" \
    --wait
  xcrun stapler staple "$dmg"
  ok "dmg notarized and stapled"
}

load_credentials() {
  local env_file="$APP_DIR/.signing.env"
  [ -f "$env_file" ] || die "No $env_file. Copy .signing.env.example and fill it in."
  # shellcheck disable=SC1090
  set -a; . "$env_file"; set +a
  for var in APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID; do
    [ -n "${!var:-}" ] || die "$var is not set in $env_file"
  done
}

echo
bold "  agentBrowser — $MODE"
echo

case "$MODE" in
  verify)
    verify_bundle "$APP"
    echo
    bold "  Done"
    exit 0
    ;;
  notarize-dmg)
    # For a build whose .app is already notarized: finishes the job on the image
    # without re-submitting the app.
    load_credentials
    ok "credentials loaded"
    notarize_dmg
    echo
    verify_bundle "$APP"
    echo
    bold "  Done"
    exit 0
    ;;
  build) ;;
  *) die "Unknown mode \"$MODE\". Use no argument, 'verify', or 'notarize-dmg'." ;;
esac

# ---------------------------------------------------------------- credentials
bold "  Preflight"

load_credentials
ok "credentials loaded"

security find-identity -v -p codesigning | grep -qF "$APPLE_SIGNING_IDENTITY" \
  || die "Signing identity not in your keychain:
  $APPLE_SIGNING_IDENTITY

Available:
$(security find-identity -v -p codesigning | sed 's/^/  /')"
ok "signing identity present"

# A stray submission from an interrupted run keeps waiting on Apple and muddies
# `notarytool history`; worth knowing about before starting another.
if pgrep -qf 'notarytool submit'; then
  warn "a notarization is already in flight — starting another will queue a second submission"
  warn "cancel this run with Ctrl-C if that was not intended"
fi

# -------------------------------------------------------------------- engine
echo
bold "  Engine"
[ -x "$REPO_ROOT/build/agentbrowser-darwin-arm64" ] \
  || die "Engine not built. From the repo root: bash scripts/build.sh"
node "$APP_DIR/scripts/sync-sidecar.mjs"
ok "sidecar in place"

# --------------------------------------------------------------------- build
echo
bold "  Building"
info "Notarization is a server-side scan at Apple. Expect a few minutes, and"
info "considerably longer for the first submission from a new Developer ID."

# Tauri reads these: signingIdentity switches from ad-hoc to real signing, and
# the Apple ID trio triggers notarization and stapling.
export APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID

npm run tauri build

# ---------------------------------------------------------------- notarize dmg
echo
bold "  Notarizing the disk image"
notarize_dmg

# -------------------------------------------------------------------- verify
echo
bold "  Verifying"
verify_bundle "$APP"

echo
bold "  Done"
info "$APP"
ls -1 "$APP_DIR/src-tauri/target/release/bundle/dmg/"*.dmg 2>/dev/null | sed 's/^/  /' || true
echo
