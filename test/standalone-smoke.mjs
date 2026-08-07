/**
 * Proves the compiled binary is genuinely self-contained.
 *
 * This is the test whose absence let a broken release ship. Every other suite
 * ran on the build machine, where playwright-core happens to sit at exactly the
 * absolute path Bun baked into the binary — so a lookup that would fail
 * everywhere else quietly succeeded here.
 *
 * We hide playwright-core for the duration, which is what every user's machine
 * looks like, and check the binary still works. node_modules is always restored,
 * including on crash or Ctrl-C.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BIN = process.env.AGENTBROWSER_BIN ?? path.join(ROOT, "build", "agentbrowser-darwin-arm64");
const CORE = path.join(ROOT, "node_modules", "playwright-core");
const HIDDEN = path.join(ROOT, "node_modules", ".playwright-core-hidden-by-test");

if (!fs.existsSync(BIN)) {
  console.error(`No binary at ${BIN}. Run: npm run compile`);
  process.exit(1);
}

let hidden = false;
function hide() {
  if (fs.existsSync(CORE)) {
    fs.renameSync(CORE, HIDDEN);
    hidden = true;
  }
}
function restore() {
  if (hidden && fs.existsSync(HIDDEN)) {
    fs.rmSync(CORE, { recursive: true, force: true });
    fs.renameSync(HIDDEN, CORE);
    hidden = false;
  }
}
// Belt and braces: a thrown error, a signal, or a bug must not leave the repo
// without its dependencies.
process.on("exit", restore);
process.on("SIGINT", () => { restore(); process.exit(130); });
process.on("uncaughtException", (error) => { restore(); throw error; });

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "agentbrowser-standalone-"));
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

function run(args) {
  return execFileSync(BIN, args, {
    env: { ...process.env, HOME: SANDBOX, AGENTBROWSER_HOME: path.join(SANDBOX, "config") },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

function main() {
  console.log(`binary:  ${BIN}`);
  console.log(`hiding:  ${CORE}\n`);
  hide();
  assert.ok(!fs.existsSync(CORE), "failed to hide playwright-core");

  console.log("Binary runs with no playwright-core on disk");
  check("version", () => assert.match(run(["version"]), /\d+\.\d+\.\d+/));
  check("help", () => assert.match(run(["help"]), /BROWSER ACTIONS/));
  check("doctor reports a usable browser", () => {
    const output = run(["doctor"]);
    assert.match(output, /Browsers \(first working one is used\)/);
    assert.match(output, /✓ (bundled|chrome|msedge)/, "no usable browser found");
  });

  console.log("\nIt can actually drive a browser");
  check("navigate", () => assert.match(run(["navigate", "example.com"]), /Navigated to/));
  check("snapshot returns real elements", () => {
    const output = run(["snapshot"]);
    assert.match(output, /heading "Example Domain"/);
    assert.match(output, /\[ref=e\d+\]/);
  });
  check("get_text", () => assert.match(run(["get_text"]), /Example Domain/));
  run(["close"]);

  console.log("\nEmbedded Playwright metadata was materialised");
  check("runtime dir created with both files", () => {
    const runtimeRoot = path.join(SANDBOX, "config", "runtime");
    assert.ok(fs.existsSync(runtimeRoot), "no runtime dir");
    const versionDir = fs.readdirSync(runtimeRoot)[0];
    const files = fs.readdirSync(path.join(runtimeRoot, versionDir)).sort();
    assert.deepEqual(files, ["browsers.json", "package.json"]);
  });
  check("browsers.json is valid and pinned", () => {
    const runtimeRoot = path.join(SANDBOX, "config", "runtime");
    const versionDir = fs.readdirSync(runtimeRoot)[0];
    const json = JSON.parse(fs.readFileSync(path.join(runtimeRoot, versionDir, "browsers.json"), "utf8"));
    assert.ok(Array.isArray(json.browsers) && json.browsers.length > 0);
    assert.ok(json.browsers.some((b) => b.name === "chromium"));
  });

  restore();
  console.log("\nnode_modules restored");
  check("playwright-core is back", () => assert.ok(fs.existsSync(path.join(CORE, "package.json"))));

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  fs.rmSync(SANDBOX, { recursive: true, force: true });
}

try {
  main();
} finally {
  restore();
}
