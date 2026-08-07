import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ACTIONS, runAction } from "../core/actions.js";
import { BrowserSession } from "../core/session.js";
import { VERSION } from "../version.js";

const INSTRUCTIONS = `agentBrowser drives a real Chromium browser over the DevTools protocol, so it is not subject to the restrictions that apply to in-page JavaScript automation. Most importantly it can attach local files to file inputs (upload_file), which a browser extension or injected script cannot do.

Recommended loop:
1. navigate to the page.
2. snapshot to see elements and their refs.
3. act by ref: click, type, upload_file, select_option.
4. snapshot again after anything that navigates or re-renders.

Credentials: never type a password with 'type'. Call list_secrets to see stored names, then fill_credential(ref, secret_name) — the value is read inside the engine and typed straight into the page, so it never enters your context.

Sessions start with no cookies and are not persisted, so each task logs in from scratch.`;

export async function startMcpServer(): Promise<void> {
  const session = new BrowserSession();
  const server = new McpServer(
    { name: "agentbrowser", version: VERSION },
    { instructions: INSTRUCTIONS },
  );

  for (const action of ACTIONS) {
    server.registerTool(
      action.name,
      {
        title: action.summary,
        description: action.description,
        inputSchema: action.schema,
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = await runAction(session, action.name, args ?? {}, "mcp");
          const content: Array<Record<string, unknown>> = [{ type: "text", text: result.text }];
          if (result.image) {
            content.push({ type: "image", data: result.image.base64, mimeType: result.image.mimeType });
          }
          return { content } as never;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true } as never;
        }
      },
    );
  }

  const shutdown = async () => {
    await session.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // stdout is the protocol channel — anything we want to say goes to stderr.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`agentbrowser MCP server ${VERSION} ready (${ACTIONS.length} tools)\n`);
}
