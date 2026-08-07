import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PATHS, ensureConfigDir } from "../core/paths.js";

/**
 * Optional: keep the CLI session daemon resident via a macOS LaunchAgent.
 *
 * Worth being clear about what this does and does not do. Claude Code and Codex
 * spawn their own `agentbrowser mcp` process when they start, so this has no
 * effect on the agent path at all — it only removes the ~1-2s daemon start on
 * the first `agentbrowser <action>` you run in a terminal.
 *
 * The resident daemon holds no browser: Chromium is launched on the first page
 * action and torn down by `close`. Idle, it is just a socket listener.
 */

const LABEL = "com.agentbrowser.daemon";

function plistPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function domain(): string {
  return `gui/${process.getuid?.() ?? ""}`;
}

function buildPlist(binary: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${binary}</string>
    <string>__daemon</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENTBROWSER_IDLE_TIMEOUT_MS</key>
    <string>0</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${PATHS.daemonLog}</string>
  <key>StandardErrorPath</key>
  <string>${PATHS.daemonLog}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

/** launchctl gained bootstrap/bootout in Yosemite; keep a legacy path anyway. */
function launchctl(modern: string[], legacy: string[]): void {
  try {
    execFileSync("launchctl", modern, { stdio: "pipe" });
  } catch {
    execFileSync("launchctl", legacy, { stdio: "pipe" });
  }
}

export function isEnabled(): boolean {
  if (!fs.existsSync(plistPath())) return false;
  try {
    execFileSync("launchctl", ["print", `${domain()}/${LABEL}`], { stdio: "pipe" });
    return true;
  } catch {
    // Plist present but not loaded — treat as not enabled so `enable` can fix it.
    return false;
  }
}

export function enableAutostart(binary: string): string[] {
  if (process.platform !== "darwin") {
    throw new Error("Autostart is macOS only.");
  }
  if (!fs.existsSync(binary)) {
    throw new Error(`Cannot find this binary at ${binary}. Install it first: agentbrowser install`);
  }

  ensureConfigDir();
  const target = plistPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });

  // Replacing an existing agent requires unloading first, or launchctl refuses.
  if (fs.existsSync(target)) {
    try {
      launchctl(["bootout", `${domain()}/${LABEL}`], ["unload", "-w", target]);
    } catch {
      /* was not loaded */
    }
  }

  fs.writeFileSync(target, buildPlist(binary));
  launchctl(["bootstrap", domain(), target], ["load", "-w", target]);

  return [
    `Autostart enabled. The session daemon will start when you log in.`,
    `  agent: ${target}`,
    `  runs:  ${binary} __daemon`,
    ``,
    `This only affects the 'agentbrowser' CLI. Claude Code and Codex start`,
    `their own MCP process, so they are unaffected either way.`,
  ];
}

export function disableAutostart(): string[] {
  const target = plistPath();
  const lines: string[] = [];

  try {
    launchctl(["bootout", `${domain()}/${LABEL}`], ["unload", "-w", target]);
    lines.push("Stopped the login agent.");
  } catch {
    lines.push("Login agent was not running.");
  }

  if (fs.existsSync(target)) {
    fs.unlinkSync(target);
    lines.push(`Removed ${target}`);
  } else {
    lines.push("No login agent was installed.");
  }
  return lines;
}

export function autostartStatus(): string[] {
  const target = plistPath();
  if (!fs.existsSync(target)) {
    return ["Autostart: off", "", "Turn it on with: agentbrowser autostart on"];
  }
  const loaded = isEnabled();
  return [
    `Autostart: ${loaded ? "on" : "installed but not loaded"}`,
    `  agent: ${target}`,
    ...(loaded ? [] : ["", "Re-apply with: agentbrowser autostart on"]),
  ];
}
