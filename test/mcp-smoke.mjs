/**
 * Verifies the MCP front-end the way Claude Code and Codex actually use it:
 * a real stdio client, real tool discovery, real tool calls.
 *
 * The CLI smoke test covers the engine; this covers the wiring an agent sees —
 * that tools are advertised with usable schemas, that results come back as
 * proper content blocks, and that errors surface as isError rather than
 * crashing the server.
 */
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startFixture } from "./fixture-server.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BIN = process.env.AGENTBROWSER_BIN ?? path.join(ROOT, "dist", "index.js");
const USE_NODE = BIN.endsWith(".js");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbrowser-mcp-"));
const UPLOAD_FILE = path.join(HOME, "mcp-payload.txt");
const UPLOAD_BODY = "uploaded through MCP\n";

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

const textOf = (result) =>
  (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

function refFor(snapshot, pattern) {
  for (const line of snapshot.split("\n")) {
    if (pattern.test(line)) {
      const match = /\[ref=([a-z0-9]+)\]/.exec(line);
      if (match) return match[1];
    }
  }
  throw new Error(`No ref matching ${pattern}\n--- snapshot ---\n${snapshot}`);
}

async function main() {
  const fixture = await startFixture(0);
  const base = `http://127.0.0.1:${fixture.port}`;
  fs.writeFileSync(UPLOAD_FILE, UPLOAD_BODY);

  // Seed the credential through the CLI path so the MCP server only ever sees a name.
  const { execFileSync } = await import("node:child_process");
  execFileSync(USE_NODE ? process.execPath : BIN, [...(USE_NODE ? [BIN] : []), "secrets", "set", "MCP_PW", fixture.PASSWORD], {
    env: { ...process.env, AGENTBROWSER_HOME: HOME },
  });

  const transport = new StdioClientTransport({
    command: USE_NODE ? process.execPath : BIN,
    args: USE_NODE ? [BIN, "mcp"] : ["mcp"],
    env: { ...process.env, AGENTBROWSER_HOME: HOME },
    stderr: "ignore",
  });

  const client = new Client({ name: "agentbrowser-smoke", version: "0" });
  await client.connect(transport);

  try {
    console.log("Tool discovery");
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    check("server advertises tools", () => assert.ok(tools.length >= 20, `only ${tools.length}`));
    check("upload_file is exposed", () => assert.ok(names.includes("upload_file")));
    check("fill_credential is exposed", () => assert.ok(names.includes("fill_credential")));
    check("tools carry input schemas", () => {
      const click = tools.find((t) => t.name === "click");
      assert.ok(click?.inputSchema?.properties?.ref, "click has no ref property");
    });

    console.log("\nLogin over MCP");
    await client.callTool({ name: "navigate", arguments: { url: base } });
    const snap = textOf(await client.callTool({ name: "snapshot", arguments: {} }));
    check("snapshot returns a usable tree", () => assert.match(snap, /textbox "Username"/));

    await client.callTool({ name: "type", arguments: { ref: refFor(snap, /textbox "Username"/), text: fixture.USERNAME } });
    const cred = textOf(
      await client.callTool({ name: "fill_credential", arguments: { ref: refFor(snap, /textbox "Password"/), secret_name: "MCP_PW" } }),
    );
    check("credential value never returned to the client", () => assert.doesNotMatch(cred, /s3cret-fixture-pw/));

    await client.callTool({ name: "click", arguments: { ref: refFor(snap, /button "Sign in"/) } });
    const afterLogin = textOf(await client.callTool({ name: "get_text", arguments: {} }));
    check("logged in over MCP", () => assert.match(afterLogin, /Dashboard/));

    console.log("\nUpload over MCP");
    const dash = textOf(await client.callTool({ name: "snapshot", arguments: {} }));
    await client.callTool({
      name: "upload_file",
      arguments: { ref: refFor(dash, /file-input/), paths: [UPLOAD_FILE] },
    });
    await client.callTool({ name: "click", arguments: { ref: refFor(dash, /button "Upload document"/) } });
    const result = textOf(await client.callTool({ name: "get_text", arguments: {} }));
    check("server confirmed upload", () => assert.match(result, /Upload complete/));
    check("bytes arrived intact", () => {
      assert.equal(fixture.received.length, 1);
      assert.equal(fixture.received[0].content, UPLOAD_BODY);
    });

    console.log("\nScreenshot content block");
    const shot = await client.callTool({ name: "screenshot", arguments: {} });
    check("returns an image block", () => {
      const image = (shot.content ?? []).find((c) => c.type === "image");
      assert.ok(image, "no image content block");
      assert.equal(image.mimeType, "image/png");
      assert.ok(image.data.length > 1000, "image data suspiciously small");
    });

    console.log("\nError handling");
    const bad = await client.callTool({ name: "click", arguments: { ref: "e9999" } });
    check("bad ref returns isError, not a crash", () => assert.equal(bad.isError, true));
    check("error explains how to recover", () => assert.match(textOf(bad), /snapshot/i));

    const stillAlive = await client.listTools();
    check("server still healthy after an error", () => assert.ok(stillAlive.tools.length > 0));

    console.log("\nSecret hygiene");
    const secrets = textOf(await client.callTool({ name: "list_secrets", arguments: {} }));
    check("list_secrets shows names", () => assert.match(secrets, /MCP_PW/));
    check("list_secrets hides values", () => assert.doesNotMatch(secrets, /s3cret-fixture-pw/));
  } finally {
    await client.close().catch(() => {});
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
  console.error("mcp smoke test crashed:", error);
  process.exit(1);
});
