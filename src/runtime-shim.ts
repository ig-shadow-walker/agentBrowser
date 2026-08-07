import fs from "node:fs";
import path from "node:path";
import { PLAYWRIGHT_ASSETS, PLAYWRIGHT_CORE_VERSION } from "./generated/playwrightAssets.js";
import { CONFIG_DIR } from "./core/paths.js";

/**
 * Gives the bundled Playwright a real directory to find its metadata in.
 *
 * playwright-core computes its own package root as `path.join(__dirname, "..")`
 * and then does `require(path.join(root, "package.json"))` and the same for
 * `browsers.json`. When Bun compiles everything into one executable it bakes
 * `__dirname` in as the path on the *build* machine, and a computed require
 * cannot be bundled — so on a user's Mac those lookups point at a directory
 * that was never there. That is the
 *   "Cannot find module .../playwright-core/package.json from /$bunfs/root/..."
 * failure.
 *
 * The build patches those two call sites to prefer AGENTBROWSER_PW_ROOT, and
 * this module materialises the files there. It MUST be imported before anything
 * that pulls in Playwright — ES module evaluation follows import order, so
 * index.ts imports it first.
 */

const RUNTIME_DIR = path.join(CONFIG_DIR, "runtime", `playwright-core-${PLAYWRIGHT_CORE_VERSION}`);

function isCurrent(file: string, expected: string): boolean {
  try {
    return fs.readFileSync(file, "utf8") === expected;
  } catch {
    return false;
  }
}

export function installPlaywrightRuntime(): string {
  try {
    let needsWrite = false;
    for (const [name, contents] of Object.entries(PLAYWRIGHT_ASSETS)) {
      if (!isCurrent(path.join(RUNTIME_DIR, name), contents)) {
        needsWrite = true;
        break;
      }
    }

    if (needsWrite) {
      fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
      for (const [name, contents] of Object.entries(PLAYWRIGHT_ASSETS)) {
        // Write-then-rename so a concurrent process never reads a partial file.
        const target = path.join(RUNTIME_DIR, name);
        const temp = `${target}.tmp-${process.pid}`;
        fs.writeFileSync(temp, contents);
        fs.renameSync(temp, target);
      }
    }

    process.env.AGENTBROWSER_PW_ROOT = RUNTIME_DIR;
    return RUNTIME_DIR;
  } catch (error) {
    // Never make this fatal: when running from source the real files are on
    // disk anyway and Playwright's own resolution works unaided.
    process.env.AGENTBROWSER_PW_ROOT ??= "";
    if (process.env.AGENTBROWSER_DEBUG === "1") {
      process.stderr.write(`runtime-shim: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    return "";
  }
}

installPlaywrightRuntime();
