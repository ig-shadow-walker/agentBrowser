import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * agentBrowser runs as an installed binary rather than from a checkout, so all
 * mutable state lives in a fixed per-user directory instead of next to the code.
 */
function resolveConfigDir(): string {
  const override = process.env.AGENTBROWSER_HOME;
  if (override) return path.resolve(override);

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "agentbrowser");
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, "agentbrowser");
  return path.join(os.homedir(), ".config", "agentbrowser");
}

export const CONFIG_DIR = resolveConfigDir();

export const PATHS = {
  configDir: CONFIG_DIR,
  secretsFile: path.join(CONFIG_DIR, "secrets.json"),
  envFile: path.join(CONFIG_DIR, ".env"),
  auditLog: path.join(CONFIG_DIR, "audit.log"),
  daemonSocket: path.join(CONFIG_DIR, "daemon.sock"),
  daemonPid: path.join(CONFIG_DIR, "daemon.pid"),
  daemonLog: path.join(CONFIG_DIR, "daemon.log"),
  downloadsDir: path.join(CONFIG_DIR, "downloads"),
  screenshotsDir: path.join(CONFIG_DIR, "screenshots"),
} as const;

/** Creates the config dir if missing. 0700 — it holds credentials. */
export function ensureConfigDir(): string {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  return CONFIG_DIR;
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
