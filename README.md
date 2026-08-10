# agentBrowser

**A headless browser your coding agent can actually drive.** Claude Code and Codex get a real Chromium with none of the restrictions that Chrome and Safari put on in-page automation — so they can log into your internal tools, fill forms, and upload files, start to finish.

---

## Contents

- [What problem this solves](#what-problem-this-solves)
- [Before you start](#before-you-start)
- [Install — step by step](#install--step-by-step)
- [Check it worked](#check-it-worked)
- [Store your logins](#store-your-logins)
- [Using it from Claude Code or Codex](#using-it-from-claude-code-or-codex)
- [Using it from the terminal](#using-it-from-the-terminal)
- [What it can do](#what-it-can-do)
- [Does it need to run in the background?](#does-it-need-to-run-in-the-background)
- [Troubleshooting](#troubleshooting)
- [Updating](#updating)
- [Uninstalling](#uninstalling)
- [Where your data lives](#where-your-data-lives)
- [For developers](#for-developers)

---

## What problem this solves

When an agent automates a browser through an extension or injected JavaScript, it hits a wall on internal tools. The clearest example is uploading a file: browsers demand a genuine human click before opening a file picker, so page-level JavaScript simply **cannot** attach a file to an upload field. That is a deliberate security protection, and there is no way around it from inside the page.

agentBrowser drives Chromium from the outside, over the DevTools Protocol. From there, setting a file on an upload field is an ordinary operation — no human click needed. The same goes for the other things in-page automation can't reach: cross-origin frames, downloads, and native dialogs.

The result is a browser your agent can use to finish a real task instead of getting stuck halfway.

---

## Before you start

You need:

- **A Mac** — Apple Silicon or Intel. (Windows and Linux are not supported yet.)
- **Claude Code or Codex** installed.
- **An internet connection** for the install.

You do **not** need Node.js, Python, or anything else. The download is a single self-contained file.

**Roughly 5 minutes**, most of it a one-time browser download.

---

## Install — step by step

### Step 1 — Run the installer

Open **Terminal** and paste this, then press Return:

```bash
curl -fsSL https://raw.githubusercontent.com/ig-shadow-walker/agentBrowser/main/scripts/install.sh | bash
```

> **Why paste a command instead of downloading and double-clicking?**
> macOS blocks apps that arrive through a browser unless they've been through Apple's paid notarization process. Downloading with `curl` avoids that block entirely, so this is one paste with no scary security warnings. See [Troubleshooting](#i-downloaded-the-file-and-double-clicked-it-but-macos-blocked-it) if you already tried the download-and-click route.

### Step 2 — Watch it work

You should see roughly this:

```
  agentBrowser installer

  ✓ macOS darwin-arm64
  ✓ Version v0.1.0
  Downloading…
  ✓ Checksum verified

  agentBrowser 0.1.0
  Installing…

  ✓ Installed to /Users/you/.local/bin/agentbrowser

  ✓ Browser ready (Playwright Chromium)

  Connecting to your agents
  ✓ Claude Code: connected
  ✓ Codex: connected

  ✓ /Users/you/.local/bin is on your PATH

  Done.
```

Two things may differ, and both are fine:

- **"Downloading Chromium (~150MB, one time)…"** appears if you don't already have a suitable browser. It takes a minute or two.
- **A question about your PATH.** If you see `is not on your PATH`, answer `Y`. This only affects whether you can type `agentbrowser` yourself in a terminal — your agent works either way, because it uses the full path.

If you see `✗` next to Claude Code or Codex, that agent isn't installed on this Mac. That's harmless — the other one still works.

### Step 3 — Restart your agent

**Quit Claude Code or Codex completely and reopen it.** They only read their tool configuration at startup, so a running instance won't see agentBrowser until you restart.

### Step 4 — Open a new terminal

Only needed if the installer changed your PATH. Otherwise skip.

---

## Check it worked

Run:

```bash
agentbrowser doctor
```

You should see something like:

```
agentbrowser 0.1.0

Binary:      /Users/you/.local/bin/agentbrowser
Config dir:  /Users/you/Library/Application Support/agentbrowser
Secrets:     none stored
Audit log:   /Users/you/Library/Application Support/agentbrowser/audit.log

Browsers (first working one is used):
  ✓ bundled  Chromium 151.0.7922.34
  ✓ chrome   Chromium 151.0.7922.77
  ✗ msedge   Chromium distribution 'msedge' is not found at /Applications/Microsoft Edge.app…

claude:      /Users/you/.local/bin/claude
codex:       not on PATH
```

**You need at least one `✓` in the browsers list.** More than one is fine — it uses the first that works. An `✗` next to a browser you don't have installed is expected and harmless.

Then confirm your agent can see it:

```bash
claude mcp list
```

```
agentbrowser: /Users/you/.local/bin/agentbrowser mcp - ✔ Connected
```

`✔ Connected` means you're done.

---

## Store your logins

Do this **before** asking an agent to log into anything. Passwords you store here never reach the agent — it only ever sees the *name* you gave them.

### The command

```bash
agentbrowser secrets set <NAME> '<value>'
```

- `<NAME>` — a label you choose. Uppercase with underscores by convention. This is what you tell the agent.
- `<value>` — the actual secret. **Always wrap it in single quotes** so `$`, `!`, spaces and other shell characters survive intact.

### Copy-paste template

```bash
# One login = two secrets (username is not sensitive, but storing it is tidier)
agentbrowser secrets set ACME_ADMIN_USER     'admin@acme.com'
agentbrowser secrets set ACME_ADMIN_PASSWORD 'your-password-here'

# An API token or key
agentbrowser secrets set ACME_API_TOKEN      'sk-live-xxxxxxxxxxxx'

# A second environment, kept separate
agentbrowser secrets set ACME_STAGING_PASSWORD 'staging-password'

# Check what is stored (names only — values are never printed)
agentbrowser secrets list

# Remove one
agentbrowser secrets rm ACME_STAGING_PASSWORD
```

Then tell your agent the **name**, never the value:

> Log into acme.com with `ACME_ADMIN_USER` and `ACME_ADMIN_PASSWORD`, then upload `~/Documents/q3.pdf` to Reports.

> **If your password contains a single quote**, use double quotes and escape any `$`, `` ` `` or `\`:
> `agentbrowser secrets set MY_PW "it's-a-p\$ssword"`

Check what you've stored:

```bash
agentbrowser secrets list
```

```
Stored credentials (values never shown):
  INTERNAL_APP_PASSWORD
```

Values are never printed — not here, not to your agent, not into the log.

**How it works.** The agent asks for a field to be filled with `INTERNAL_APP_PASSWORD`. agentBrowser looks the value up itself and types it straight into the page. The password never passes through the agent's reasoning, never lands in your chat transcript, and never enters the audit log:

```
Filled input "Password" [e2] with secret "INTERNAL_APP_PASSWORD" (value not shown).
```

Remove one with `agentbrowser secrets rm INTERNAL_APP_PASSWORD`.

---

## Using it from Claude Code or Codex

There's nothing to invoke. Just ask, in plain language:

> Log into our admin tool at internal.example.com as `admin` using the stored `INTERNAL_APP_PASSWORD`, go to Reports, and upload `~/Documents/q3.pdf`.

Behind the scenes the agent takes a *snapshot* of the page — a compact list of everything it can interact with, each tagged with an id:

```
Page: http://internal.example.com/
Title: Internal Tool Login

- heading "Internal Tool Login" (level=1)
- form
  - text "Username"
  - textbox "Username" [ref=e1]
  - text "Password"
  - textbox "Password" [ref=e2]
  - button "Sign in" [ref=e3]
```

It then acts on those ids — type into `e1`, fill `e2` from your stored secret, click `e3`. After anything that changes the page it takes a fresh snapshot.

**A safety detail worth knowing:** every snapshot is stamped with a token identifying that exact page. If the page navigates or reloads, ids from the old snapshot are **refused** rather than silently clicking whatever now happens to sit in that position. A wrong click on an internal system is the failure mode most worth preventing.

### Two useful things to tell your agent

- *"Take a screenshot"* — when you want to see what it sees.
- *"Start a fresh session"* — clears all cookies and logs out of everything.

---

## Using it from the terminal

Everything the agent can do, you can do by hand — useful for testing a flow before handing it over.

```bash
agentbrowser navigate internal.example.com
agentbrowser snapshot
```

```
- textbox "Username" [ref=e1]
- textbox "Password" [ref=e2]
- button "Sign in" [ref=e3]
```

```bash
agentbrowser type e1 admin
agentbrowser fill_credential e2 INTERNAL_APP_PASSWORD
agentbrowser click e3
agentbrowser snapshot
```

```
- file-input "Attach document" [ref=e1] (single-file)
- button "Upload document" [ref=e2]
```

```bash
agentbrowser upload_file e1 ~/Documents/q3.pdf
```

```
Set 1 file(s) on input [e1]: q3.pdf
```

```bash
agentbrowser click e2
agentbrowser close
```

**Commands share one browser session**, so the page stays put between them. `agentbrowser close` ends the session; it also closes itself after 30 minutes idle.

Run `agentbrowser help` for everything, or `agentbrowser help upload_file` for one command.

---

## What it can do

| Command | What it does |
| --- | --- |
| `navigate` `go_back` `go_forward` `reload` | Move around |
| `snapshot` | Read the page as a list of elements with ids |
| `screenshot` | Capture a PNG |
| `get_text` | Pull out the readable text |
| `click` `hover` `press_key` `scroll` | Interact |
| `type` `select_option` `set_checked` | Fill in forms |
| `fill_credential` | Type a stored password without revealing it |
| `upload_file` | Attach files — the thing extensions can't do |
| `list_downloads` | Files the site downloaded, and where they went |
| `wait_for` | Wait for text, or for the page to settle |
| `evaluate` | Run JavaScript on the page |
| `list_tabs` `new_tab` `select_tab` `close_tab` | Tabs |
| `list_secrets` | Names of stored logins (never values) |
| `reset_session` | Log out of everything, clear cookies |

`upload_file` handles both a plain upload field **and** the common design where a styled button opens a hidden picker. Pass whichever one the snapshot shows you — it works both ways.

---

## Troubleshooting

### `agentbrowser: command not found`

The install folder isn't on your PATH. Either open a new terminal (if the installer just added it), or add it yourself:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && exec $SHELL
```

Your agent is unaffected by this — it uses the full path.

### My agent doesn't see the browser tools

1. **Restart it completely.** Tool configuration is only read at startup.
2. Check the connection:
   ```bash
   claude mcp list
   ```
   You want `agentbrowser: … ✔ Connected`.
3. If it's missing, reconnect and restart again:
   ```bash
   agentbrowser install-mcp
   ```

### `No usable Chromium found`

Run `agentbrowser doctor` — you need at least one `✓` in the browsers list. If there are none, either:

```bash
agentbrowser install-browser
```

or simply **install Google Chrome** — agentBrowser picks it up automatically, no configuration needed.

### I downloaded the file and double-clicked it, but macOS blocked it

Expected. macOS blocks apps that arrive through a browser, Slack, or AirDrop unless they've been notarized by Apple. **Use the [install command](#step-1--run-the-installer) instead** — downloading with `curl` avoids the block completely.

If you must use a file you already downloaded, clear the flag first:

```bash
xattr -d com.apple.quarantine ~/Downloads/agentbrowser-darwin-arm64
chmod +x ~/Downloads/agentbrowser-darwin-arm64
~/Downloads/agentbrowser-darwin-arm64
```

That last line installs it — the binary installs itself when you run it from outside its install folder.

### "Refs are stale" or "call snapshot again"

Working as intended. The page changed, so the old element ids no longer describe it. Take a fresh snapshot. Agents handle this on their own.

### The agent clicked the wrong thing

Take a screenshot to see the page as it is, then a fresh snapshot. If an element never shows up in the snapshot, it may be inside an iframe — those appear in a separate section with ids like `f1e5`.

### Something went wrong and I want to see what it did

```bash
agentbrowser audit 50
```

Every action, in order:

```
{"ts":"2026-08-07T12:42:01.113Z","action":"upload_file","via":"cli","args":{"ref":"e1","paths":["/tmp/q3-report.txt"]},"ok":true,"ms":32}
```

Passwords never appear here — see [Where your data lives](#where-your-data-lives).

### Starting over

```bash
agentbrowser close          # end the browser session
agentbrowser reset_session  # or just drop all cookies and logins
```

---

## Does it need to run in the background?

**No. There is nothing to start, and nothing runs when you are not using it.**

- **For Claude Code and Codex** — they launch their own `agentbrowser` process when they start, and shut it down when they quit. Nothing for you to manage.
- **For the terminal** — the first `agentbrowser` command starts a session automatically. It exits on its own after 30 minutes idle, or immediately on `agentbrowser close`.

Idle, agentBrowser uses **zero** memory — no process, no browser. Chromium only launches on the first page action (about 270MB, plus 126MB for the session) and is freed on `close`.

### Starting it at login anyway

If you would rather the terminal session daemon be resident:

```bash
agentbrowser autostart on      # start at login
agentbrowser autostart status  # check
agentbrowser autostart off     # stop and remove
```

This installs a macOS LaunchAgent at `~/Library/LaunchAgents/com.agentbrowser.daemon.plist`, with `KeepAlive` so it comes back if it ever dies. The resident daemon never times out.

**Most people should leave this off.** What it costs versus what it buys:

| | Autostart off (default) | Autostart on |
| --- | --- | --- |
| Memory when unused | 0 MB | ~120 MB, always |
| First terminal command | ~1–2s slower | instant |
| Claude Code / Codex | no difference | no difference |

The daemon holds no browser either way — that ~120 MB is the runtime itself, resident whether you use it that day or not. It buys a second or two on the first CLI command and nothing for your agent, which starts its own process regardless.

`agentbrowser uninstall` removes the login agent automatically.

## Updating

Re-run the install command. It replaces the binary in place and keeps your stored logins and settings:

```bash
curl -fsSL https://raw.githubusercontent.com/ig-shadow-walker/agentBrowser/main/scripts/install.sh | bash
```

Restart your agent afterwards.

---

## Uninstalling

```bash
agentbrowser uninstall
```

Removes the program and disconnects it from Claude Code and Codex. **Your stored logins and logs are deliberately kept** in case you reinstall. To delete those too:

```bash
rm -rf ~/Library/Application\ Support/agentbrowser
```

---

## Where your data lives

Everything stays on your Mac. There is no server, no account, and no telemetry.

| What | Where |
| --- | --- |
| Stored logins | `~/Library/Application Support/agentbrowser/secrets.json` (owner-only, mode `0600`) |
| Activity log | `~/Library/Application Support/agentbrowser/audit.log` |
| Downloads | `~/Library/Application Support/agentbrowser/downloads/` |
| Screenshots | `~/Library/Application Support/agentbrowser/screenshots/` |

**On passwords.** Stored values are read only by the browser engine and typed straight into the page. They are never returned to the agent, never written to the log, and passwords already typed into a field show as `«hidden»` in snapshots. If a password somehow reaches a log field anyway, it's replaced with `«redacted»` — the log is scrubbed against every value you've stored.

**On sessions.** Each session starts with no cookies and nothing saved, so every task logs in fresh and nothing carries over between tasks. Nothing is written to a browser profile on disk.

**Worth being clear about:** an agent driving this browser can do anything *you* could do while logged in. Give it credentials scoped to the task, not your admin account.

---

## For developers

### Build and test

```bash
npm install
npx playwright install chromium

npm run build          # TypeScript -> dist/
npm test               # both suites against the dev build
npm run compile        # standalone binaries -> build/
npm run test:binary    # all three suites against the compiled binary
```

Three suites, all running against a fixture "internal app" with a login form and two upload paths:

| Suite | Covers |
| --- | --- |
| `test/smoke.mjs` | The engine through the CLI — login, both upload styles, stale-ref refusal, audit redaction |
| `test/mcp-smoke.mjs` | The MCP wiring an agent sees — tool discovery, content blocks, error recovery |
| `test/install-smoke.mjs` | Download → run → installed → registered → uninstall, in a sandboxed `HOME` |
| `test/standalone-smoke.mjs` | The binary with `playwright-core` hidden — proves it is genuinely self-contained |

`standalone-smoke.mjs` earns its place. Every other suite runs on the build machine, where `playwright-core` sits at exactly the absolute path Bun baked into the binary — so a lookup that fails on every other machine succeeds there. A release shipped broken this way once. Never remove this test.

`scripts/release.sh` runs all four in a clean clone before it will publish anything.

### How the binary stays self-contained

`playwright-core` finds its own `package.json` and `browsers.json` with `require(path.join(__dirname, ".."))`. Bun compiles `__dirname` to the build machine's absolute path and cannot bundle a computed `require`, so both lookups fail elsewhere. Three pieces fix it:

- `scripts/gen-assets.mjs` embeds both files into the source at build time
- `scripts/patch-bundle.mjs` redirects the lookup to `AGENTBROWSER_PW_ROOT`, and **fails the build** if Playwright's internals change so the patch stops matching
- `src/runtime-shim.ts` writes the embedded copies out at startup, before anything imports Playwright

### Releasing

Binaries are never committed — `build/` is gitignored. They ship as GitHub Release assets, which live outside the repo.

There is no CI. One command does everything:

```bash
bash scripts/release.sh 0.1.3
```

It refuses to publish unless every check passes:

1. **Preflight** — `gh` authenticated, on `main`, clean tree, in sync with origin, tag and release both free
2. **Version** — sets `package.json` and `src/version.ts`, commits
3. **Clean-room build** — clones to a temp dir, `npm ci`, builds there
4. **Tests** — all four suites against the binaries being shipped
5. **Publish** — only now does it tag, push, and upload assets

Nothing is pushed or published until step 4 passes. If a suite fails you are left with a local version-bump commit and nothing else; `git reset --soft HEAD~1` undoes it.

**Step 3 is the important one.** Both releases that shipped broken did so because the artifact was built in a working tree containing files a fresh `npm ci` does not produce — once a stale `playwright-core` path, once a missing `fsevents`. Building in a throwaway clone is what catches that class of bug. Do not "optimise" it away by building in place.

To test `install.sh` without publishing anything, point it at a local server:

```bash
AGENTBROWSER_BASE_URL="http://127.0.0.1:8123" bash scripts/install.sh
```

### Layout

```
src/core/            engine — session, snapshot/refs, secrets, audit, browser launch
src/core/actions.ts  every action, defined once, driving both front-ends
src/mcp/             MCP stdio server
src/cli/             CLI, session daemon, unix-socket protocol
src/install/         self-install and agent registration
```

Every action is declared once in `src/core/actions.ts` with a zod schema. The MCP server turns each into a tool and the CLI turns each into a subcommand, so the two can't drift apart.

### Notes for future work

- **Double-click install** needs an Apple Developer account ($99/yr) plus signing and notarization in the release workflow. The self-install code already supports it — only the signature is missing.
- **Windows and Linux** would need their own build targets and install paths; the engine itself is portable.
- **Playwright's own browser downloader** can't run inside the compiled binary (it forks a helper that isn't on disk), which is why `install-browser` falls back to `npx playwright install` and then to a system Chrome.
