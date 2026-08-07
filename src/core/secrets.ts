import fs from "node:fs";
import { PATHS, ensureConfigDir } from "./paths.js";

/**
 * Local credential store. Values are read only by the engine and typed straight
 * into the page by `fill_credential` — they are never returned to the agent and
 * never written to the audit log.
 *
 * Resolution order for a name:
 *   1. env var AGENTBROWSER_SECRET_<NAME>
 *   2. secrets.json
 *   3. .env (KEY=value)
 */

type SecretMap = Record<string, string>;

function readJsonStore(): SecretMap {
  try {
    const raw = fs.readFileSync(PATHS.secretsFile, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: SecretMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function readEnvStore(): SecretMap {
  try {
    const raw = fs.readFileSync(PATHS.envFile, "utf8");
    const out: SecretMap = {};
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      // Strip a single layer of matching quotes.
      if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
        value = value.slice(1, -1);
      }
      if (key) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function envVarFor(name: string): string | undefined {
  const key = `AGENTBROWSER_SECRET_${name.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase()}`;
  return process.env[key];
}

/** Merged view of every configured secret. Kept internal. */
function loadAll(): SecretMap {
  return { ...readEnvStore(), ...readJsonStore() };
}

export function getSecret(name: string): string | undefined {
  const fromEnv = envVarFor(name);
  if (fromEnv !== undefined) return fromEnv;
  return loadAll()[name];
}

/** Names only — never values. Safe to show an agent so it can discover what exists. */
export function listSecretNames(): string[] {
  const names = new Set(Object.keys(loadAll()));
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("AGENTBROWSER_SECRET_")) {
      names.add(key.slice("AGENTBROWSER_SECRET_".length));
    }
  }
  return [...names].sort();
}

export function setSecret(name: string, value: string): void {
  ensureConfigDir();
  const store = readJsonStore();
  store[name] = value;
  writeJsonStore(store);
}

export function removeSecret(name: string): boolean {
  const store = readJsonStore();
  if (!(name in store)) return false;
  delete store[name];
  writeJsonStore(store);
  return true;
}

function writeJsonStore(store: SecretMap): void {
  ensureConfigDir();
  // 0600 — owner read/write only.
  fs.writeFileSync(PATHS.secretsFile, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(PATHS.secretsFile, 0o600);
  } catch {
    /* best effort on exotic filesystems */
  }
}

/**
 * Replaces any known secret value found in `text` with a placeholder. Used to
 * scrub the audit log so a credential can't leak even if the agent typed it
 * through the generic `type` action instead of `fill_credential`.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  const values = Object.values(loadAll());
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("AGENTBROWSER_SECRET_")) {
      const v = process.env[key];
      if (v) values.push(v);
    }
  }
  // Longest first so overlapping values redact cleanly.
  for (const value of [...new Set(values)].sort((a, b) => b.length - a.length)) {
    if (value.length < 3) continue; // too short to match meaningfully
    out = out.split(value).join("«redacted»");
  }
  return out;
}
