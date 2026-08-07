/**
 * Redirects playwright-core's self-locating package root to a runtime path.
 *
 * playwright-core does:
 *     packageRoot = path.join(__dirname, "..")
 *     packageJSON = require(path.join(packageRoot, "package.json"))
 *     registry    = new Registry(require(path.join(packageRoot, "browsers.json")))
 *
 * Bun compiles `__dirname` to the build machine's absolute path and cannot
 * bundle a require() of a computed path, so both lookups fail on any other
 * machine. We rewrite the assignment to prefer AGENTBROWSER_PW_ROOT, which
 * src/runtime-shim.ts populates with the embedded copies at startup.
 *
 * If the pattern stops matching — a Playwright upgrade changing this code —
 * this script exits non-zero. A loud build failure is the point: the
 * alternative is a binary that works on the build machine and nowhere else.
 */
import fs from "node:fs";

const [, , bundlePath] = process.argv;
if (!bundlePath) {
  console.error("usage: patch-bundle.mjs <bundle.js>");
  process.exit(1);
}

const source = fs.readFileSync(bundlePath, "utf8");

// e.g.  packageRoot = import_path9.default.join(__dirname, "..");
//  and  var packageRoot = import_path.default.join(__dirname, "..");
const PATTERN = /(\bpackageRoot\s*=\s*)([A-Za-z_$][\w$]*\.default\.join\(__dirname,\s*"\.\."\))/g;

const matches = [...source.matchAll(PATTERN)];
const EXPECTED = 2;

if (matches.length === 0) {
  console.error(
    [
      "patch-bundle: FAILED — playwright-core's packageRoot assignment was not found.",
      "",
      "Playwright's internals have changed. The compiled binary would look for",
      "package.json and browsers.json at the build machine's path and fail on",
      "every other machine.",
      "",
      "Fix: find how playwright-core now computes its package root in the bundle",
      "and update PATTERN in scripts/patch-bundle.mjs to match.",
    ].join("\n"),
  );
  process.exit(1);
}

if (matches.length !== EXPECTED) {
  console.warn(`patch-bundle: expected ${EXPECTED} occurrences, found ${matches.length} — continuing, but verify the standalone test passes.`);
}

const patched = source.replace(PATTERN, "$1(process.env.AGENTBROWSER_PW_ROOT || $2)");

if (patched === source) {
  console.error("patch-bundle: FAILED — replacement produced no change.");
  process.exit(1);
}

fs.writeFileSync(bundlePath, patched);
console.log(`patch-bundle: redirected ${matches.length} packageRoot assignment(s) to AGENTBROWSER_PW_ROOT`);
