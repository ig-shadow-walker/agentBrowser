import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Registers the installed binary as an MCP server with Claude Code and Codex.
 *
 * Both CLIs have their own `mcp add` command, which is the safest path because
 * it owns its own config format. When that isn't available we fall back to
 * editing the config file directly, additively — an existing entry is reported
 * and left alone rather than overwritten.
 */

export interface RegistrationResult {
  target: string;
  status: "added" | "already-present" | "skipped" | "failed";
  detail: string;
}

const SERVER_NAME = "agentbrowser";

function hasCommand(command: string): boolean {
  try {
    execFileSync("which", [command], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export function registerClaudeCode(binPath: string): RegistrationResult {
  const target = "Claude Code";

  if (hasCommand("claude")) {
    try {
      const existing = execFileSync("claude", ["mcp", "list"], { stdio: "pipe", encoding: "utf8" });
      if (existing.includes(SERVER_NAME)) {
        return { target, status: "already-present", detail: `"${SERVER_NAME}" is already registered.` };
      }
    } catch {
      /* `mcp list` can fail on older versions; fall through to add */
    }
    try {
      execFileSync("claude", ["mcp", "add", SERVER_NAME, "--scope", "user", "--", binPath, "mcp"], { stdio: "pipe" });
      return { target, status: "added", detail: "Registered via `claude mcp add` (user scope)." };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fallbackClaudeJson(binPath, `\`claude mcp add\` failed (${message.split("\n")[0]}); wrote config directly.`);
    }
  }

  return fallbackClaudeJson(binPath, "`claude` CLI not found; wrote config directly.");
}

function fallbackClaudeJson(binPath: string, note: string): RegistrationResult {
  const target = "Claude Code";
  const configPath = path.join(os.homedir(), ".claude.json");
  try {
    let config: Record<string, unknown> = {};
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf8").trim();
      if (raw) config = JSON.parse(raw) as Record<string, unknown>;
    }
    const servers = (config.mcpServers as Record<string, unknown> | undefined) ?? {};
    if (servers[SERVER_NAME]) {
      return { target, status: "already-present", detail: `"${SERVER_NAME}" already present in ${configPath}.` };
    }
    servers[SERVER_NAME] = { command: binPath, args: ["mcp"] };
    config.mcpServers = servers;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    return { target, status: "added", detail: `${note} (${configPath})` };
  } catch (error) {
    return {
      target,
      status: "failed",
      detail: `Could not write ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function registerCodex(binPath: string): RegistrationResult {
  const target = "Codex";

  if (hasCommand("codex")) {
    try {
      execFileSync("codex", ["mcp", "add", SERVER_NAME, "--", binPath, "mcp"], { stdio: "pipe" });
      return { target, status: "added", detail: "Registered via `codex mcp add`." };
    } catch {
      /* older codex builds have no `mcp add`; fall through to TOML */
    }
  }

  const configPath = path.join(os.homedir(), ".codex", "config.toml");
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
    if (existing.includes(`[mcp_servers.${SERVER_NAME}]`)) {
      return { target, status: "already-present", detail: `"${SERVER_NAME}" already present in ${configPath}.` };
    }
    const block = [
      "",
      `[mcp_servers.${SERVER_NAME}]`,
      `command = ${JSON.stringify(binPath)}`,
      `args = ["mcp"]`,
      "",
    ].join("\n");
    fs.appendFileSync(configPath, (existing.endsWith("\n") || !existing ? "" : "\n") + block);
    return { target, status: "added", detail: `Appended to ${configPath}.` };
  } catch (error) {
    return {
      target,
      status: "failed",
      detail: `Could not write ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function registerAll(binPath: string): RegistrationResult[] {
  return [registerClaudeCode(binPath), registerCodex(binPath)];
}
