import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { execFileSync } from "node:child_process";
import { registerAll } from "./register.js";
import { probeChannels } from "../core/launch.js";
import { PATHS, ensureConfigDir } from "../core/paths.js";
import { VERSION, PLAYWRIGHT_VERSION } from "../version.js";

/**
 * Makes the downloaded binary install itself.
 *
 * A user who double-clicks the file in Finder gets a Terminal window running it
 * with no arguments. Printing help there is useless — they wanted to install it.
 * So when we detect we are running from somewhere that is not a bin directory,
 * we treat a bare invocation as "install me".
 */

const BIN_NAME = "agentbrowser";

const INSTALL_DIRS = [
  path.join(os.homedir(), ".local", "bin"),
  "/usr/local/bin",
  "/opt/homebrew/bin",
];

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

const say = (s = "") => process.stdout.write(s + "\n");
const step = (s: string) => say(`  ${s}`);
const ok = (s: string) => say(`  ${green("✓")} ${s}`);
const warn = (s: string) => say(`  ${yellow("!")} ${s}`);

/**
 * Compares two paths by their resolved form. Necessary because macOS resolves
 * `/var` to `/private/var` (and `process.execPath` comes back fully resolved),
 * so a plain string comparison against an unresolved install dir never matches.
 */
function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
}

/** True when this binary already lives somewhere on a normal PATH. */
export function isInstalled(): boolean {
  const dir = path.dirname(process.execPath);
  return INSTALL_DIRS.some((candidate) => samePath(dir, candidate));
}

/** Bare `agentbrowser` from a download folder means "install", not "show help". */
export function shouldSelfInstall(): boolean {
  // Running from source under node is development, never an install.
  if (process.argv[1]?.endsWith(".js")) return false;
  return !isInstalled();
}

function stripQuarantine(target: string): void {
  try {
    execFileSync("xattr", ["-d", "com.apple.quarantine", target], { stdio: "pipe" });
  } catch {
    /* attribute usually absent; nothing to do */
  }
}

function shellRcPath(): string {
  const shell = process.env.SHELL ?? "";
  if (shell.includes("bash")) return path.join(os.homedir(), ".bashrc");
  if (shell.includes("fish")) return path.join(os.homedir(), ".config", "fish", "config.fish");
  return path.join(os.homedir(), ".zshrc");
}

function onPath(dir: string): boolean {
  return (process.env.PATH ?? "").split(":").includes(dir);
}

async function ask(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`  ${question} [Y/n] `)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function ensureBrowser(): Promise<boolean> {
  const probes = await probeChannels();
  const working = probes.find((p) => p.ok);
  if (working) {
    ok(`Browser ready (${working.channel === "bundled" ? "Playwright Chromium" : working.channel})`);
    return true;
  }

  step("No browser found. Downloading Chromium (~150MB, one time)…");
  try {
    const { program } = await import("playwright/lib/program");
    await program.parseAsync(["install", "chromium"], { from: "user" });
    ok("Chromium installed");
    return true;
  } catch {
    /* the compiled binary cannot always spawn Playwright's download helper */
  }

  try {
    execFileSync("npx", ["--yes", `playwright@${PLAYWRIGHT_VERSION}`, "install", "chromium"], { stdio: "pipe" });
    ok("Chromium installed (via npx playwright)");
    return true;
  } catch {
    /* npx unavailable or failed */
  }

  warn("Could not install Chromium automatically.");
  step(dim("Install Google Chrome — agentBrowser will use it automatically —"));
  step(dim(`or run: npx playwright@${PLAYWRIGHT_VERSION} install chromium`));
  return false;
}

export async function runSelfInstall(): Promise<void> {
  say();
  say(bold(`  agentBrowser ${VERSION}`));
  say(dim("  Installing…"));
  say();

  const installDir = INSTALL_DIRS[0]!;
  const target = path.join(installDir, BIN_NAME);
  const source = process.execPath;

  // ------------------------------------------------------------ copy binary
  if (samePath(source, target)) {
    ok(`Already installed at ${target}`);
  } else {
    if (fs.existsSync(target)) {
      // A running daemon holds the old binary open; stop it before replacing.
      try {
        execFileSync(target, ["close"], { stdio: "pipe", timeout: 15_000 });
      } catch {
        /* nothing running */
      }
      step(dim("Replacing existing install"));
    }
    fs.mkdirSync(installDir, { recursive: true });
    // Write to a temp name then rename, so a crash never leaves a half-copied
    // binary sitting on PATH.
    const temp = `${target}.new-${process.pid}`;
    fs.copyFileSync(source, temp);
    fs.chmodSync(temp, 0o755);
    fs.renameSync(temp, target);
    stripQuarantine(target);
    ok(`Installed to ${target}`);
  }

  ensureConfigDir();

  // ---------------------------------------------------------------- browser
  say();
  await ensureBrowser();

  // -------------------------------------------------------------------- MCP
  say();
  step(bold("Connecting to your agents"));
  const results = registerAll(target, ["mcp"]);
  for (const r of results) {
    if (r.status === "added") ok(`${r.target}: connected`);
    else if (r.status === "already-present") ok(`${r.target}: already connected`);
    else warn(`${r.target}: ${r.detail}`);
  }

  // ------------------------------------------------------------------- PATH
  say();
  if (onPath(installDir)) {
    ok(`${installDir} is on your PATH`);
  } else {
    const rc = shellRcPath();
    warn(`${installDir} is not on your PATH`);
    step(dim("Your agents will still work — they use the full path."));
    step(dim(`Adding it lets you run '${BIN_NAME}' yourself in a terminal.`));
    say();
    if (await ask(`Add it to ${path.basename(rc)}?`)) {
      const line =
        rc.endsWith("config.fish")
          ? `\nfish_add_path ${installDir}\n`
          : `\nexport PATH="${installDir}:$PATH"\n`;
      fs.appendFileSync(rc, line);
      ok(`Added to ${rc} — open a new terminal to pick it up`);
    } else {
      step(dim(`Add manually: export PATH="${installDir}:$PATH"`));
    }
  }

  // ---------------------------------------------------------------- summary
  say();
  say(bold("  Done."));
  say();
  say("  Restart Claude Code or Codex, then just ask it to use the browser.");
  say();
  say(dim("  Store a login so it never reaches the agent's context:"));
  say(`    ${BIN_NAME} secrets set MY_APP_PASSWORD '…'`);
  say();
  say(dim(`  Logs and settings: ${PATHS.configDir}`));
  say(dim(`  Remove it again:   ${BIN_NAME} uninstall`));
  say();

  // A Finder double-click opens a Terminal window that closes on exit, taking
  // this output with it. Hold it open so the user can actually read the result.
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await rl.question(dim("  Press Return to close. "));
    rl.close();
  }
}

export async function runUninstall(): Promise<void> {
  say();
  say(bold("  Uninstalling agentBrowser"));
  say();

  for (const dir of INSTALL_DIRS) {
    const target = path.join(dir, BIN_NAME);
    if (!fs.existsSync(target)) continue;
    try {
      execFileSync(target, ["close"], { stdio: "pipe", timeout: 15_000 });
    } catch {
      /* nothing running */
    }
    fs.unlinkSync(target);
    ok(`Removed ${target}`);
  }

  // Unregister where we can; leave anything we did not add alone.
  try {
    execFileSync("claude", ["mcp", "remove", BIN_NAME, "--scope", "user"], { stdio: "pipe" });
    ok("Disconnected from Claude Code");
  } catch {
    warn("Could not auto-remove from Claude Code — run: claude mcp remove agentbrowser");
  }
  try {
    execFileSync("codex", ["mcp", "remove", BIN_NAME], { stdio: "pipe" });
    ok("Disconnected from Codex");
  } catch {
    warn(`Could not auto-remove from Codex — edit ${path.join(os.homedir(), ".codex", "config.toml")}`);
  }

  say();
  step(dim(`Credentials and logs are kept at ${PATHS.configDir}`));
  step(dim("Delete that folder yourself if you want them gone."));
  say();
}
