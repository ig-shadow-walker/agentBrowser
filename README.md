# agentBrowser

A headless browser that Claude Code and Codex can drive **without the restrictions Chrome and Safari impose on in-page automation**.

## Why this exists

Agents that automate a browser through an extension or injected JavaScript hit a wall on internal tools. The clearest case is file upload: browsers require a genuine user gesture before opening a file picker, so page-level JS cannot attach a file to `<input type="file">`. That is a deliberate anti-abuse protection, and it cannot be worked around from inside the page.

agentBrowser drives Chromium over the DevTools Protocol instead. From outside the page, setting files on an input is a normal operation — no gesture required. The same applies to the other things in-page automation cannot reach: cross-origin frames, downloads, and dialogs.

The result is a browser an agent can use to log into internal software and finish a real task end to end.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/ig-shadow-walker/agentBrowser/main/scripts/install.sh | bash
```

macOS, Apple Silicon and Intel. The installer downloads the binary, verifies its checksum, puts it on your `PATH`, makes sure a Chromium is available, and registers it as an MCP server with Claude Code and Codex. Restart your agent afterwards to pick it up.

No Node.js required — the binary is self-contained.

## How agents use it

Once registered, Claude Code and Codex call it as MCP tools. The loop is:

1. `navigate` to the page
2. `snapshot` to see the elements and their refs
3. act by ref — `click`, `type`, `upload_file`, `select_option`
4. `snapshot` again after anything that navigates

A snapshot looks like this:

```
- heading "Internal Tool Login" (level=1)
- textbox "Username" [ref=e4]
- textbox "Password" [ref=e6]
- button "Sign in" [ref=e7]
```

The agent then calls `click("e7")`. Refs are stable while the page is, and every ref carries a document token — if the page navigates or re-renders, stale refs are **refused** rather than silently clicking the wrong element.

## Credentials

Credentials live in a local file and never enter the agent's context.

```bash
agentbrowser secrets set INTERNAL_APP_PASSWORD 'hunter2'
```

The agent calls `list_secrets` to discover names, then:

```
fill_credential(ref="e6", secret_name="INTERNAL_APP_PASSWORD")
```

The engine reads the value and types it straight into the page. It is never returned to the agent, never written to the transcript, and never written to the audit log — the log records only that `INTERNAL_APP_PASSWORD` was used. Passwords already typed into a field are also masked in snapshots.

Values are stored in `~/Library/Application Support/agentbrowser/secrets.json` (mode `0600`). Nothing leaves your machine.

## CLI

Everything the agent can do, you can do:

```bash
agentbrowser navigate internal.example.com
agentbrowser snapshot
agentbrowser type e4 admin
agentbrowser fill_credential e6 INTERNAL_APP_PASSWORD --submit
agentbrowser upload_file e12 ~/reports/q3.pdf
agentbrowser close
```

CLI commands share one browser session held by a background daemon, so state persists between invocations. `close` ends it. The daemon also exits on its own after 30 minutes idle.

Run `agentbrowser help` for the full list, or `agentbrowser help <action>` for one.

## Actions

| Action | Purpose |
| --- | --- |
| `navigate`, `go_back`, `go_forward`, `reload` | Movement |
| `snapshot` | Element tree with refs — the main way to read a page |
| `screenshot` | PNG, when the visual rendering matters |
| `get_text` | Readable page text |
| `click`, `hover`, `press_key`, `scroll` | Interaction |
| `type`, `select_option`, `set_checked` | Form input |
| `fill_credential` | Type a stored secret without revealing it |
| `upload_file` | Attach local files — the capability extensions cannot provide |
| `list_downloads` | Files the page downloaded, and where they were saved |
| `wait_for` | Wait for text, a load state, or a delay |
| `evaluate` | Run JavaScript in the page |
| `list_tabs`, `new_tab`, `select_tab`, `close_tab` | Tabs |
| `list_secrets` | Credential names (never values) |
| `reset_session` | Drop all cookies and start clean |

`upload_file` handles both a real `<input type="file">` and the common pattern of a styled button that opens a hidden picker — pass whichever element the snapshot shows.

## Sessions

Sessions are deliberately **not** persistent. Each one starts with no cookies and no storage, so every task authenticates from scratch and nothing leaks between tasks. Nothing is written to a browser profile on disk.

## Audit log

Every action is appended to `~/Library/Application Support/agentbrowser/audit.log` as JSON — what ran, against which URL, whether it succeeded. Since this operates on real internal systems with real credentials, the log is how you check what an agent actually did.

```bash
agentbrowser audit 50
```

Credential values never appear. Any known secret value found in a logged field is replaced with `«redacted»`, so a password stays out of the log even if an agent typed it through `type` instead of `fill_credential`.

## Troubleshooting

```bash
agentbrowser doctor
```

Shows the install paths and which browsers are usable. agentBrowser prefers Playwright's pinned Chromium, then a system Google Chrome, then Edge. If none work:

```bash
agentbrowser install-browser
```

If that fails (the compiled binary cannot always spawn Playwright's downloader), either install Google Chrome — it is picked up automatically — or run `npx playwright@1.62.1 install chromium`.

To register with your agents manually:

```bash
agentbrowser install-mcp
```

## Development

```bash
npm install
npx playwright install chromium
npm run build          # TypeScript -> dist/
node test/smoke.mjs    # end-to-end against a fixture internal app
node test/mcp-smoke.mjs
npm run compile        # standalone binaries -> build/
```

The test fixture in `test/fixture-server.mjs` is a miniature internal app with a login form and two upload paths, including the hidden-input pattern. Both suites run against the compiled binary in CI so packaging regressions fail the release.

### Layout

```
src/core/      engine — session, snapshot/refs, secrets, audit, browser launch
src/core/actions.ts   every action, defined once, driving both front-ends
src/mcp/       MCP stdio server
src/cli/       CLI, session daemon, unix-socket protocol
src/install/   MCP registration for Claude Code and Codex
```

Actions are declared once in `src/core/actions.ts` with a zod schema. The MCP server turns each into a tool and the CLI turns each into a subcommand, so the two cannot drift apart.

## Security notes

- Runs entirely on your machine. No server, no telemetry, no remote component.
- Credentials are read only by the engine and are never returned to the agent.
- The audit log records every action with secret values stripped.
- The binary is ad-hoc signed, not notarized. The installer strips the quarantine attribute so Gatekeeper does not block it.
- An agent driving this browser can do anything you can do while logged in. Give it credentials scoped to what the task needs.
