# agentBrowser — menu bar app

A macOS control panel for the agentBrowser engine: a menu bar icon, a small
window for managing stored credentials, and a one-click install.

## It is a control panel, not a runtime

Claude Code and Codex launch the engine themselves — that is how MCP works. So
this app is **not** required for an agent to browse. Quitting it changes
nothing about whether your agent works. It exists to make installing and
configuring the engine pleasant, not to run it.

The engine itself is the TypeScript project in `../src`, compiled to a single
binary and shipped inside this app as a Tauri sidecar.

## Running it

```bash
npm install
npm run tauri dev      # live-reloading dev build
npm run tauri build    # release .app and .dmg in src-tauri/target/release/bundle/
```

The first Rust build takes several minutes; later ones are seconds.

## Layout

```
index.html          shell markup
src/main.ts         talks to Rust via invoke()
src/styles.css      native-feeling light/dark styling
src-tauri/
  src/lib.rs        app setup, tray, commands
  src/main.rs       entry point
  tauri.conf.json   window, bundle and signing config
  capabilities/     what the frontend is permitted to call
```

## Build status

| Step | State |
| --- | --- |
| 1. Scaffold that builds and runs | done |
| 2. Menu bar icon, no Dock icon | not started |
| 3. Secrets UI | not started |
| 4. Engine bundled as sidecar | not started |
| 5. First-launch setup | not started |
| 6. Launch at login | not started |
| 7. Signed and notarized DMG | blocked on an Apple Developer certificate |

## Notes

**Permissions are explicit.** Tauri v2 denies everything the frontend is not
granted in `src-tauri/capabilities/`. Adding a capability to the UI means adding
its permission there too — this is a feature, not an obstacle.

**Windows icons were removed.** This app is macOS only, so the `Square*Logo.png`
and `.ico` files the scaffold generated were deleted and dropped from
`tauri.conf.json`.
