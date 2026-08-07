import fs from "node:fs";
import { PATHS, ensureConfigDir } from "./paths.js";
import { redactSecrets } from "./secrets.js";

/**
 * Append-only local record of everything the tool did on the user's behalf.
 * This runs against real internal systems with real credentials, so the log is
 * the user's way of reviewing what an agent actually did.
 *
 * Credential values never reach this file: `fill_credential` logs only the
 * secret's name, and every free-text field is passed through `redactSecrets`.
 */

export interface AuditEntry {
  ts: string;
  action: string;
  via: "mcp" | "cli";
  url?: string;
  args?: Record<string, unknown>;
  ok: boolean;
  ms?: number;
  error?: string;
}

const MAX_FIELD = 300;

function scrubValue(value: unknown): unknown {
  if (typeof value === "string") {
    const redacted = redactSecrets(value);
    return redacted.length > MAX_FIELD ? redacted.slice(0, MAX_FIELD) + `…(+${redacted.length - MAX_FIELD})` : redacted;
  }
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrubValue(v);
    return out;
  }
  return value;
}

/**
 * Fields whose value is inherently a secret reference rather than content.
 * `secret_name` is safe to log (that is the point of it); a raw `value`/`text`
 * on the credential action would not be, so it is dropped entirely.
 */
function sanitizeArgs(action: string, args: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!args) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (action === "fill_credential" && k !== "ref" && k !== "secret_name" && k !== "submit") continue;
    out[k] = scrubValue(v);
  }
  return out;
}

export function recordAction(entry: Omit<AuditEntry, "ts"> & { ts?: string }): void {
  if (process.env.AGENTBROWSER_NO_AUDIT === "1") return;
  try {
    ensureConfigDir();
    const line: AuditEntry = {
      ts: entry.ts ?? new Date().toISOString(),
      action: entry.action,
      via: entry.via,
      ...(entry.url ? { url: redactSecrets(entry.url) } : {}),
      ...(entry.args ? { args: sanitizeArgs(entry.action, entry.args) } : {}),
      ok: entry.ok,
      ...(entry.ms !== undefined ? { ms: entry.ms } : {}),
      ...(entry.error ? { error: redactSecrets(entry.error).slice(0, 500) } : {}),
    };
    fs.appendFileSync(PATHS.auditLog, JSON.stringify(line) + "\n", { mode: 0o600 });
  } catch {
    // Logging must never break the actual browser task.
  }
}

export function readAuditTail(lines: number): string[] {
  try {
    const raw = fs.readFileSync(PATHS.auditLog, "utf8");
    return raw.split(/\r?\n/).filter(Boolean).slice(-lines);
  } catch {
    return [];
  }
}
