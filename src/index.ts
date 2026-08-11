#!/usr/bin/env node
// MUST come first: gives the bundled Playwright a real directory to find its
// package.json and browsers.json in. ES module evaluation follows import order,
// so this runs before anything pulls Playwright in. See src/runtime-shim.ts.
import "./runtime-shim.js";

import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { ACTIONS, ACTIONS_BY_NAME } from "./core/actions.js";
import { PATHS, ensureConfigDir } from "./core/paths.js";
import { listSecretNames, setSecret, removeSecret } from "./core/secrets.js";
import { readAuditTail } from "./core/audit.js";
import { probeChannels } from "./core/launch.js";
import { parseArgs, usageFor } from "./cli/args.js";
import { send, isDaemonRunning } from "./cli/client.js";
import { startDaemon } from "./cli/daemon.js";
import { startMcpServer } from "./mcp/server.js";
import os from "node:os";
import path from "node:path";
import { registerAll, selfInvocation } from "./install/register.js";
import { enableAutostart, disableAutostart, autostartStatus } from "./install/autostart.js";
import { runSelfInstall, runUninstall, shouldSelfInstall } from "./install/selfInstall.js";
import { VERSION, PLAYWRIGHT_VERSION } from "./version.js";

function out(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : text + "\n");
}

function fail(text: string): never {
  process.stderr.write(text.endsWith("\n") ? text : text + "\n");
  process.exit(1);
}

function helpText(): string {
  const width = Math.max(...ACTIONS.map((a) => a.name.length)) + 2;
  const actions = ACTIONS.map((a) => `  ${a.name.padEnd(width)}${a.summary}`).join("\n");
  return `agentbrowser ${VERSION} — an unrestricted headless browser for coding agents

USAGE
  agentbrowser <command> [arguments] [--options]

BROWSER ACTIONS
${actions}

MANAGING THE SESSION
  status                    Show whether a browser session is running
  close                     Close the browser and end the session
  audit [n]                 Show the last n audited actions (default 20)
  autostart on|off|status   Keep the CLI daemon running from login (optional)

CREDENTIALS
  secrets list              List stored credential names
  secrets set <NAME> <VAL>  Store a credential
  secrets rm <NAME>         Remove a credential

SETUP
  install                   Install onto PATH and connect to Claude Code / Codex
  uninstall                 Remove the binary and disconnect from your agents
  mcp                       Run as an MCP server over stdio (how agents call it)
  install-mcp               Register this binary with Claude Code and Codex
  install-browser           Download the Chromium build this version needs
  doctor                    Check the installation

  help [action]             Show help, optionally for one action
  version                   Print the version

NOTES
  CLI actions share one browser session that persists between commands, so you
  can navigate, snapshot and click across separate invocations. 'close' ends it.
  Sessions never persist cookies to disk — each new session starts logged out.

  Config and logs live in ${PATHS.configDir}`;
}

async function runBrowserAction(name: string, argv: string[]): Promise<void> {
  const action = ACTIONS_BY_NAME.get(name);
  if (!action) fail(`Unknown command "${name}". Run 'agentbrowser help' to see available commands.`);

  let args: Record<string, unknown>;
  try {
    args = parseArgs(action, argv);
  } catch (error) {
    fail(`${error instanceof Error ? error.message : String(error)}\n\n${usageFor(action)}`);
  }

  const response = await send({ action: name, args });
  if (!response.ok) fail(`Error: ${response.error ?? "unknown error"}`);
  if (response.text) out(response.text);
}

async function handleSecrets(argv: string[]): Promise<void> {
  const sub = argv[0];

  if (!sub || sub === "list") {
    const names = listSecretNames();
    // --json exists so the menu bar app has a stable contract to read, rather
    // than screen-scraping prose that changes whenever the wording improves.
    if (argv.includes("--json")) {
      out(JSON.stringify(names));
      return;
    }
    out(
      names.length
        ? `Stored credentials (values never shown):\n${names.map((n) => `  ${n}`).join("\n")}`
        : `No credentials stored yet.\n\nAdd one with:\n  agentbrowser secrets set MY_APP_PASSWORD 'hunter2'\n\nStored in ${PATHS.secretsFile} (mode 0600).`,
    );
    return;
  }

  if (sub === "set") {
    const name = argv[1];
    const value = argv[2];
    if (!name || value === undefined) {
      fail("Usage: agentbrowser secrets set <NAME> <VALUE>");
    }
    setSecret(name, value);
    out(`Stored "${name}" in ${PATHS.secretsFile}.\nUse it with: fill_credential(ref, "${name}")`);
    return;
  }

  if (sub === "rm" || sub === "remove" || sub === "delete") {
    const name = argv[1];
    if (!name) fail("Usage: agentbrowser secrets rm <NAME>");
    out(removeSecret(name) ? `Removed "${name}".` : `No stored credential named "${name}".`);
    return;
  }

  fail(`Unknown secrets subcommand "${sub}". Use: list, set, rm`);
}

async function doctor(): Promise<void> {
  const lines: string[] = [`agentbrowser ${VERSION}`, ""];

  lines.push(`Binary:      ${process.execPath}`);
  lines.push(`Config dir:  ${PATHS.configDir}${fs.existsSync(PATHS.configDir) ? "" : "  (not created yet)"}`);
  lines.push(`Secrets:     ${fs.existsSync(PATHS.secretsFile) ? `${listSecretNames().length} stored` : "none stored"}`);
  lines.push(`Audit log:   ${fs.existsSync(PATHS.auditLog) ? PATHS.auditLog : "no actions recorded yet"}`);

  lines.push("");
  lines.push("Browsers (first working one is used):");
  const probes = await probeChannels();
  for (const probe of probes) {
    lines.push(`  ${probe.ok ? "✓" : "✗"} ${probe.channel.padEnd(8)} ${probe.detail}`);
  }
  if (!probes.some((p) => p.ok)) {
    lines.push("");
    lines.push("  No usable browser. Run 'agentbrowser install-browser', or install Google Chrome.");
  }
  lines.push("");

  for (const [label, command] of [["claude", "claude"], ["codex", "codex"]] as const) {
    let found = "not on PATH";
    try {
      found = execFileSync("which", [command], { stdio: "pipe", encoding: "utf8" }).trim();
    } catch { /* not installed */ }
    lines.push(`${(label + ":").padEnd(12)} ${found}`);
  }

  out(lines.join("\n"));
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;

  switch (command) {
    // A bare invocation from outside a bin directory means the user just
    // downloaded this file and ran it — install, rather than print help at them.
    case undefined:
      if (shouldSelfInstall()) {
        await runSelfInstall();
        return;
      }
      out(helpText());
      return;

    case "install":
      await runSelfInstall();
      return;

    case "uninstall":
      await runUninstall();
      return;

    case "help":
    case "-h":
    case "--help": {
      const topic = rest[0];
      if (topic) {
        const action = ACTIONS_BY_NAME.get(topic);
        if (!action) fail(`No action named "${topic}".`);
        out(usageFor(action));
        return;
      }
      out(helpText());
      return;
    }

    case "version":
    case "-v":
    case "--version":
      out(VERSION);
      return;

    case "mcp":
      await startMcpServer();
      return;

    case "__daemon":
      await startDaemon();
      return;

    case "status": {
      const running = await isDaemonRunning();
      out(running ? `Browser session running (socket ${PATHS.daemonSocket}).` : "No browser session running.");
      return;
    }

    case "close":
    case "stop": {
      if (!(await isDaemonRunning())) {
        out("No browser session running.");
        return;
      }
      const response = await send({ control: "shutdown" });
      // The daemon acknowledges before it tears the browser down, so wait for
      // it to actually go away — otherwise `close` followed by `status` lies.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && (await isDaemonRunning())) {
        await new Promise((r) => setTimeout(r, 50));
      }
      out(response.text ?? "Session closed.");
      return;
    }

    case "audit": {
      const n = Number(rest[0] ?? 20);
      const lines = readAuditTail(Number.isFinite(n) ? n : 20);
      out(lines.length ? lines.join("\n") : "No actions recorded yet.");
      return;
    }

    case "secrets":
      await handleSecrets(rest);
      return;

    case "install-mcp": {
      ensureConfigDir();
      const { command: cmd, args } = selfInvocation();
      out(`Registering: ${[cmd, ...args].join(" ")}\n`);
      for (const r of registerAll(cmd, args)) {
        const mark = r.status === "added" ? "✓" : r.status === "already-present" ? "•" : "✗";
        out(`${mark} ${r.target}: ${r.detail}`);
      }
      out("\nRestart Claude Code or Codex to pick up the new server.");
      return;
    }

    case "install-browser": {
      // Delegates to Playwright's own downloader, which knows the pinned
      // revision and CDN layout for this exact Playwright version. Inside a
      // compiled binary the download runs in a forked helper that isn't on
      // disk, so this can fail — in which case we point at the alternatives
      // rather than pretending it worked.
      try {
        const { program } = await import("playwright/lib/program");
        await program.parseAsync(["install", "chromium"], { from: "user" });
        out("Chromium is installed.");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fail(
          [
            `Could not download Chromium: ${message.split("\n")[0]}`,
            "",
            "Use either of these instead:",
            `  npx playwright@${PLAYWRIGHT_VERSION} install chromium    (needs Node.js)`,
            "  install Google Chrome — agentBrowser will use it automatically",
            "",
            "Check what is usable with: agentbrowser doctor",
          ].join("\n"),
        );
      }
      return;
    }

    case "autostart": {
      const sub = rest[0] ?? "status";
      // Prefer the installed copy: registering a path under build/ or a
      // Downloads folder would break the moment that file moves.
      const binary = process.argv[1]?.endsWith(".js")
        ? path.join(os.homedir(), ".local", "bin", "agentbrowser")
        : process.execPath;

      if (sub === "on" || sub === "enable") {
        out(enableAutostart(binary).join("\n"));
      } else if (sub === "off" || sub === "disable") {
        out(disableAutostart().join("\n"));
      } else if (sub === "status") {
        out(autostartStatus().join("\n"));
      } else {
        fail(`Unknown autostart option "${sub}". Use: on, off, status`);
      }
      return;
    }

    case "doctor":
      await doctor();
      return;

    default:
      await runBrowserAction(command, rest);
  }
}

main().catch((error) => {
  fail(`Error: ${error instanceof Error ? error.message : String(error)}`);
});
