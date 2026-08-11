/**
 * Copies the compiled engine into the app as a Tauri sidecar.
 *
 * Tauri requires sidecars to be named `<name>-<target-triple>`; it strips the
 * triple when bundling, so the app ends up with one binary per architecture in
 * Contents/MacOS/. The names are not optional — a mismatch fails the build with
 * a confusing "binary not found" rather than anything pointing here.
 *
 *   node app/scripts/sync-sidecar.mjs
 *
 * Run after `scripts/build.sh` at the repo root, which produces the engine.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.dirname(APP_DIR);
const ENGINE_BUILD = path.join(REPO_ROOT, "build");
const OUT_DIR = path.join(APP_DIR, "src-tauri", "binaries");

/** Engine build output -> Rust target triple Tauri expects. */
const MAPPING = [
  { from: "agentbrowser-darwin-arm64", triple: "aarch64-apple-darwin" },
  { from: "agentbrowser-darwin-x64", triple: "x86_64-apple-darwin" },
];

const missing = MAPPING.filter((m) => !fs.existsSync(path.join(ENGINE_BUILD, m.from)));
if (missing.length) {
  console.error(
    [
      `sync-sidecar: engine binaries not found in ${path.relative(process.cwd(), ENGINE_BUILD)}`,
      ...missing.map((m) => `  missing: ${m.from}`),
      "",
      "Build the engine first, from the repo root:",
      "  bash scripts/build.sh",
    ].join("\n"),
  );
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

for (const { from, triple } of MAPPING) {
  const source = path.join(ENGINE_BUILD, from);
  const target = path.join(OUT_DIR, `agentbrowser-${triple}`);
  fs.copyFileSync(source, target);
  fs.chmodSync(target, 0o755);
  const mb = (fs.statSync(target).size / 1048576).toFixed(1);
  console.log(`sync-sidecar: agentbrowser-${triple}  (${mb} MB)`);
}
