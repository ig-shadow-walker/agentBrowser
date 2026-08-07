/**
 * End-to-end check of the real binary against the fixture app.
 *
 * Drives agentBrowser exactly the way an agent would — snapshot, read refs act
 * on them — and asserts the two things that matter most: that a credential can
 * be typed without ever appearing in the agent-visible output or the audit log,
 * and that both kinds of file upload genuinely deliver bytes to the server.
 *
 * Runs against a throwaway AGENTBROWSER_HOME so it never touches real config.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { startFixture } from "./fixture-server.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = process.env.AGENTBROWSER_BIN ?? path.join(ROOT, "dist", "index.js");
const USE_NODE = CLI.endsWith(".js");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbrowser-smoke-"));
const UPLOAD_FILE = path.join(HOME, "quarterly-report.txt");
const UPLOAD_BODY = "agentBrowser upload fixture payload\n";

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

async function ab(...args) {
  const command = USE_NODE ? process.execPath : CLI;
  const argv = USE_NODE ? [CLI, ...args] : args;
  const { stdout } = await execFileAsync(command, argv, {
    env: { ...process.env, AGENTBROWSER_HOME: HOME },
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

/** Finds the ref for the first element whose rendered line matches a pattern. */
function refFor(snapshot, pattern) {
  for (const line of snapshot.split("\n")) {
    if (pattern.test(line)) {
      const match = /\[ref=([a-z0-9]+)\]/.exec(line);
      if (match) return match[1];
    }
  }
  throw new Error(`No ref found matching ${pattern}\n--- snapshot ---\n${snapshot}`);
}

async function main() {
  const fixture = await startFixture(0);
  const base = `http://127.0.0.1:${fixture.port}`;
  fs.writeFileSync(UPLOAD_FILE, UPLOAD_BODY);
  console.log(`fixture app: ${base}`);
  console.log(`sandbox home: ${HOME}\n`);

  try {
    console.log("Login flow");
    await ab("secrets", "set", "FIXTURE_PW", fixture.PASSWORD);
    const secretList = await ab("secrets", "list");
    check("secrets list shows the name", () => assert.match(secretList, /FIXTURE_PW/));
    check("secrets list hides the value", () => assert.doesNotMatch(secretList, /s3cret-fixture-pw/));

    await ab("navigate", base);
    const loginSnapshot = await ab("snapshot");
    check("snapshot finds the login form", () => assert.match(loginSnapshot, /textbox "Username"/));

    const userRef = refFor(loginSnapshot, /textbox "Username"/);
    const passRef = refFor(loginSnapshot, /textbox "Password"/);
    const signInRef = refFor(loginSnapshot, /button "Sign in"/);

    await ab("type", userRef, fixture.USERNAME);
    const credOut = await ab("fill_credential", passRef, "FIXTURE_PW");
    check("fill_credential does not echo the secret", () => assert.doesNotMatch(credOut, /s3cret-fixture-pw/));

    await ab("click", signInRef);
    const afterLogin = await ab("get_text");
    check("login succeeded", () => assert.match(afterLogin, /Dashboard/));
    check("landed on /dashboard", () => assert.match(afterLogin, /\/dashboard/));

    console.log("\nDirect file input");
    const dashSnapshot = await ab("snapshot");
    check("file input is visible in snapshot", () => assert.match(dashSnapshot, /file-input/));

    const plainFileRef = refFor(dashSnapshot, /file-input .*Attach document|Attach document.*file-input/);
    const uploadOut = await ab("upload_file", plainFileRef, UPLOAD_FILE);
    check("upload_file reports the attached file", () => assert.match(uploadOut, /quarterly-report\.txt/));

    await ab("click", refFor(dashSnapshot, /button "Upload document"/));
    const uploadResult = await ab("get_text");
    check("server confirmed the upload", () => assert.match(uploadResult, /Upload complete/));
    check("server received one file", () => assert.equal(fixture.received.length, 1));
    check("bytes arrived intact", () => assert.equal(fixture.received[0].content, UPLOAD_BODY));

    console.log("\nStyled upload button (hidden input via file chooser)");
    await ab("navigate", `${base}/dashboard`);
    const dash2 = await ab("snapshot");
    const pickRef = refFor(dash2, /button "Choose file…"/);
    const styledOut = await ab("upload_file", pickRef, UPLOAD_FILE);
    check("styled trigger accepted the file", () => assert.match(styledOut, /quarterly-report\.txt/));

    const dash3 = await ab("snapshot");
    check("page reflects the chosen file", () => assert.match(dash3, /Selected: quarterly-report\.txt/));
    await ab("click", refFor(dash3, /button "Upload chosen"/));
    const styledResult = await ab("get_text");
    check("server confirmed the styled upload", () => assert.match(styledResult, /Upload complete/));
    check("server received a second file", () => assert.equal(fixture.received.length, 2));

    console.log("\nStale-ref protection");
    await ab("navigate", `${base}/dashboard`);
    let staleError = "";
    try {
      await ab("click", plainFileRef);
    } catch (error) {
      staleError = String(error.stderr ?? error.message);
    }
    check("refs from a previous page are refused", () => assert.match(staleError, /stale|snapshot\(\) again/i));

    console.log("\nAudit log");
    const audit = await ab("audit", "100");
    check("audit recorded the actions", () => assert.match(audit, /"action":"upload_file"/));
    check("audit names the secret used", () => assert.match(audit, /FIXTURE_PW/));
    check("audit never contains the password", () => assert.doesNotMatch(audit, /s3cret-fixture-pw/));

    console.log("\nSession control");
    const status = await ab("status");
    check("session reported running", () => assert.match(status, /running/));
    await ab("close");
    const statusAfter = await ab("status");
    check("session closed cleanly", () => assert.match(statusAfter, /No browser session/));
  } finally {
    await ab("close").catch(() => {});
    fixture.server.close();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  fs.rmSync(HOME, { recursive: true, force: true });
}

main().catch((error) => {
  console.error("smoke test crashed:", error);
  process.exit(1);
});
