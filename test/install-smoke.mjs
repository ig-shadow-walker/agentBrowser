/**
 * Covers the flow a real user takes: download the binary, run it, get a working
 * install — plus the things that must NOT happen, like an installed copy
 * re-installing itself every time it is run bare.
 *
 * Everything happens under a throwaway HOME, so the real ~/.claude.json,
 * ~/.codex/config.toml and ~/.local/bin are never touched.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BIN = process.env.AGENTBROWSER_BIN ?? path.join(ROOT, "build", "agentbrowser-darwin-arm64");

if (!fs.existsSync(BIN)) {
  console.error(`No binary at ${BIN}. Run: npm run compile`);
  process.exit(1);
}

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "agentbrowser-install-"));
const DOWNLOADS = path.join(SANDBOX, "Downloads");
const DOWNLOADED = path.join(DOWNLOADS, "agentbrowser-darwin-arm64");
const INSTALLED = path.join(SANDBOX, ".local", "bin", "agentbrowser");

let passed = 0;
const failures = [];

function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    console.log(`  ✗ ${label}\n      ${error.message}`);
  }
}

/** Runs a binary with HOME pointed at the sandbox and no PATH inheritance games. */
function run(binary, args = []) {
  return execFileSync(binary, args, {
    env: { ...process.env, HOME: SANDBOX, AGENTBROWSER_HOME: path.join(SANDBOX, "config") },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

function main() {
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  fs.copyFileSync(BIN, DOWNLOADED);
  fs.chmodSync(DOWNLOADED, 0o755);
  console.log(`sandbox HOME: ${SANDBOX}\n`);

  console.log("Downloaded binary, run bare (the double-click path)");
  const installOutput = run(DOWNLOADED);
  check("reports installing, not help", () => {
    assert.match(installOutput, /Installing/);
    assert.doesNotMatch(installOutput, /BROWSER ACTIONS/);
  });
  check("binary landed in ~/.local/bin", () => assert.ok(fs.existsSync(INSTALLED)));
  check("installed copy is executable", () => {
    assert.ok(fs.statSync(INSTALLED).mode & 0o111);
  });
  check("installed copy is byte-identical", () => {
    assert.equal(fs.statSync(INSTALLED).size, fs.statSync(BIN).size);
  });
  check("reports done", () => assert.match(installOutput, /Done\./));

  console.log("\nAgent registration");
  check("registered with Claude Code", () => {
    const config = JSON.parse(fs.readFileSync(path.join(SANDBOX, ".claude.json"), "utf8"));
    const entry = config.mcpServers?.agentbrowser;
    assert.ok(entry, "no agentbrowser entry");
    assert.equal(entry.command, INSTALLED, "registered the wrong path");
    assert.deepEqual(entry.args, ["mcp"]);
  });
  check("registered with Codex", () => {
    const toml = fs.readFileSync(path.join(SANDBOX, ".codex", "config.toml"), "utf8");
    assert.match(toml, /\[mcp_servers\.agentbrowser\]/);
    assert.ok(toml.includes(INSTALLED), "registered the wrong path");
  });
  check("registers the INSTALLED path, not the download", () => {
    const config = JSON.parse(fs.readFileSync(path.join(SANDBOX, ".claude.json"), "utf8"));
    assert.notEqual(config.mcpServers.agentbrowser.command, DOWNLOADED);
  });

  console.log("\nInstalled copy behaves as a normal CLI");
  check("bare run now prints help, not another install", () => {
    const output = run(INSTALLED);
    assert.match(output, /BROWSER ACTIONS/);
    assert.doesNotMatch(output, /Installing/);
  });
  check("version works", () => assert.match(run(INSTALLED, ["version"]), /\d+\.\d+\.\d+/));
  check("it can actually drive a browser", () => {
    const output = run(INSTALLED, ["navigate", "example.com"]);
    assert.match(output, /Navigated to/);
    run(INSTALLED, ["close"]);
  });

  console.log("\nRe-running the downloaded copy is safe");
  check("second install is idempotent", () => {
    const output = run(DOWNLOADED);
    assert.match(output, /already connected|connected/);
    const config = JSON.parse(fs.readFileSync(path.join(SANDBOX, ".claude.json"), "utf8"));
    assert.equal(Object.keys(config.mcpServers).filter((k) => k === "agentbrowser").length, 1);
  });

  console.log("\nUninstall");
  const uninstallOutput = run(INSTALLED, ["uninstall"]);
  check("binary removed", () => assert.ok(!fs.existsSync(INSTALLED)));
  check("credentials and logs deliberately kept", () => {
    assert.match(uninstallOutput, /Credentials and logs are kept/);
    assert.ok(fs.existsSync(path.join(SANDBOX, "config")), "config dir was destroyed");
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  fs.rmSync(SANDBOX, { recursive: true, force: true });
}

main();
