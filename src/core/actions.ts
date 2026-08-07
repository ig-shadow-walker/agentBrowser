import { z } from "zod";
import type { BrowserSession } from "./session.js";
import { listSecretNames } from "./secrets.js";
import { recordAction } from "./audit.js";

/**
 * The single source of truth for what agentBrowser can do.
 *
 * Both front-ends are generated from this list: the MCP server turns each entry
 * into a tool, the CLI turns each into a subcommand. Adding a capability here
 * makes it available in both, with identical validation and audit logging.
 */

export interface ActionResult {
  text: string;
  /** Present only for screenshot — MCP returns it as an image block. */
  image?: { base64: string; mimeType: string };
}

export interface ActionDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  summary: string;
  description: string;
  schema: S;
  /** Order in which bare CLI arguments map onto schema keys. */
  positional?: string[];
  /** The final positional key collects all remaining CLI arguments. */
  variadic?: boolean;
  /** True for actions that change page state — used for audit emphasis. */
  mutating?: boolean;
  handler: (session: BrowserSession, args: any) => ActionResult | string | Promise<ActionResult | string>;
}

function def<S extends z.ZodRawShape>(d: ActionDef<S>): ActionDef<z.ZodRawShape> {
  return d as unknown as ActionDef<z.ZodRawShape>;
}

const REF_HELP = 'Element ref from the most recent snapshot, e.g. "e12" (or "f1e12" for an element inside iframe 1).';

export const ACTIONS: ActionDef[] = [
  def({
    name: "navigate",
    summary: "Go to a URL",
    description:
      "Navigate the active tab to a URL. Starts the browser if it is not running yet. After navigating, call snapshot to see the page.",
    schema: {
      url: z.string().describe("URL to open. A bare host like 'example.com' is treated as https."),
      wait_until: z
        .enum(["load", "domcontentloaded", "networkidle"])
        .optional()
        .describe("When to consider navigation finished. Default domcontentloaded."),
    },
    positional: ["url"],
    mutating: true,
    handler: (s, a) => s.navigate(a.url, a.wait_until),
  }),

  def({
    name: "snapshot",
    summary: "Read the page as an element tree with refs",
    description:
      "Return an accessibility-style tree of the current page: each interactive element gets a stable ref like [ref=e12] which you pass to click, type, upload_file and the other actions. This is the cheapest and most reliable way to see a page — prefer it over screenshot unless you specifically need to see the visual rendering. Refs stay valid until the page navigates or re-renders; if an action reports stale refs, call snapshot again.",
    schema: {
      filter: z
        .enum(["all", "interactive"])
        .optional()
        .describe("'all' includes text content for context; 'interactive' returns only actionable elements. Default 'all'."),
    },
    positional: ["filter"],
    handler: (s, a) => s.snapshot(a.filter ?? "all"),
  }),

  def({
    name: "screenshot",
    summary: "Capture a PNG of the page or one element",
    description:
      "Take a PNG screenshot of the active tab. Use when the visual rendering matters (layout, charts, canvas) or when a snapshot is not enough to understand the page. Costs far more context than snapshot, so do not use it as the default way to read a page.",
    schema: {
      full_page: z.boolean().optional().describe("Capture the entire scrollable page instead of the viewport."),
      ref: z.string().optional().describe(`Capture only this element. ${REF_HELP}`),
    },
    handler: async (s, a) => {
      const shot = await s.screenshot(a.full_page ?? false, a.ref);
      return { text: shot.text, image: { base64: shot.base64, mimeType: "image/png" } };
    },
  }),

  def({
    name: "click",
    summary: "Click an element by ref",
    description: `Click an element. ${REF_HELP} If the click navigates, the reply says so and you must call snapshot again before using older refs.`,
    schema: {
      ref: z.string().describe(REF_HELP),
      button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button. Default left."),
      double: z.boolean().optional().describe("Double-click instead of a single click."),
      force: z.boolean().optional().describe("Skip actionability checks. Use only when a normal click times out."),
    },
    positional: ["ref"],
    mutating: true,
    handler: (s, a) => s.click(a.ref, { button: a.button, clickCount: a.double ? 2 : 1, force: a.force }),
  }),

  def({
    name: "type",
    summary: "Type text into a field",
    description:
      "Type text into an input, textarea or contenteditable element. Clears the field first by default. Never use this for passwords or other stored credentials — use fill_credential instead so the value stays out of your context and the audit log.",
    schema: {
      ref: z.string().describe(REF_HELP),
      text: z.string().describe("Text to type."),
      submit: z.boolean().optional().describe("Press Enter afterwards."),
      clear: z.boolean().optional().describe("Clear the field before typing. Default true."),
      delay_ms: z.number().optional().describe("Per-keystroke delay. Use when a field needs real key events to trigger its handlers."),
    },
    positional: ["ref", "text"],
    mutating: true,
    handler: (s, a) => s.type(a.ref, a.text, { submit: a.submit, clear: a.clear, delayMs: a.delay_ms }),
  }),

  def({
    name: "fill_credential",
    summary: "Type a stored secret into a field without revealing it",
    description:
      "Fill a field with a credential from the local secret store, identified by name. The engine reads the value and types it directly into the page — the value is never returned to you and never written to the audit log. Use this for every password, API key or token. Call list_secrets to see which names exist.",
    schema: {
      ref: z.string().describe(REF_HELP),
      secret_name: z.string().describe("Name of the secret in the local store, e.g. 'INTERNAL_APP_PASSWORD'."),
      submit: z.boolean().optional().describe("Press Enter afterwards."),
    },
    positional: ["ref", "secret_name"],
    mutating: true,
    handler: (s, a) => s.fillCredential(a.ref, a.secret_name, { submit: a.submit }),
  }),

  def({
    name: "upload_file",
    summary: "Attach local files to a file input",
    description:
      "Set local files on a file input. This works on the real `<input type=file>` and also on styled upload buttons that open a hidden file chooser — pass whichever element you can see in the snapshot. This is the capability that in-page browser automation cannot do, because browsers require a genuine user gesture to open a file picker.",
    schema: {
      ref: z.string().describe(`The file input, or the button that opens it. ${REF_HELP}`),
      paths: z.array(z.string()).describe("Absolute paths of local files to attach."),
    },
    positional: ["ref", "paths"],
    variadic: true,
    mutating: true,
    handler: (s, a) => s.uploadFile(a.ref, a.paths),
  }),

  def({
    name: "select_option",
    summary: "Choose option(s) in a dropdown",
    description: "Select one or more options in a <select>. Matches on option value first, then on visible label.",
    schema: {
      ref: z.string().describe(REF_HELP),
      values: z.array(z.string()).describe("Option values or visible labels to select."),
    },
    positional: ["ref", "values"],
    variadic: true,
    mutating: true,
    handler: (s, a) => s.select(a.ref, a.values),
  }),

  def({
    name: "set_checked",
    summary: "Check or uncheck a checkbox/radio",
    description: "Check or uncheck a checkbox or radio button, using the element's real toggle behaviour.",
    schema: {
      ref: z.string().describe(REF_HELP),
      checked: z.boolean().describe("true to check, false to uncheck."),
    },
    positional: ["ref", "checked"],
    mutating: true,
    handler: (s, a) => s.check(a.ref, a.checked),
  }),

  def({
    name: "hover",
    summary: "Hover over an element",
    description: "Move the mouse over an element, to reveal menus, tooltips or hover-only controls.",
    schema: { ref: z.string().describe(REF_HELP) },
    positional: ["ref"],
    mutating: true,
    handler: (s, a) => s.hover(a.ref),
  }),

  def({
    name: "press_key",
    summary: "Press a keyboard key",
    description:
      "Press a key such as Enter, Tab, Escape, ArrowDown, or a chord like 'Control+A'. Targets a specific element if a ref is given, otherwise the focused element.",
    schema: {
      key: z.string().describe("Key name, e.g. 'Enter', 'Escape', 'Tab', 'Control+A'."),
      ref: z.string().optional().describe(`Optional element to focus first. ${REF_HELP}`),
    },
    positional: ["key", "ref"],
    mutating: true,
    handler: (s, a) => s.pressKey(a.key, a.ref),
  }),

  def({
    name: "scroll",
    summary: "Scroll the page or bring an element into view",
    description: "Scroll the viewport in a direction, or scroll a specific element into view when a ref is given.",
    schema: {
      direction: z.enum(["up", "down", "left", "right"]).optional().describe("Scroll direction. Default down."),
      amount: z.number().optional().describe("Pixels to scroll. Default 600."),
      ref: z.string().optional().describe(`Scroll this element into view instead. ${REF_HELP}`),
    },
    positional: ["direction"],
    handler: (s, a) => s.scroll(a.direction ?? "down", a.amount ?? 600, a.ref),
  }),

  def({
    name: "get_text",
    summary: "Extract readable page text",
    description: "Return the visible text of the page, preferring <main> or <article>. Use for reading content rather than for deciding what to click.",
    schema: { max_chars: z.number().optional().describe("Truncate after this many characters. Default 20000.") },
    handler: (s, a) => s.getText(a.max_chars ?? 20_000),
  }),

  def({
    name: "wait_for",
    summary: "Wait for text, a load state, or a fixed delay",
    description: "Wait until given text becomes visible, or until the page reaches a load state, or simply for a number of milliseconds.",
    schema: {
      text: z.string().optional().describe("Wait until this text is visible on the page."),
      state: z.enum(["load", "domcontentloaded", "networkidle"]).optional().describe("Wait for this load state."),
      ms: z.number().optional().describe("Wait a fixed number of milliseconds."),
    },
    positional: ["text"],
    handler: (s, a) => s.waitFor({ text: a.text, state: a.state, ms: a.ms }),
  }),

  def({
    name: "evaluate",
    summary: "Run JavaScript in the page",
    description:
      "Evaluate a JavaScript expression in the page and return the result as JSON. Useful for inspecting state that the snapshot does not expose. Prefer the dedicated actions for interaction — page JS cannot set file inputs, which is exactly what upload_file exists for.",
    schema: { expression: z.string().describe("A JavaScript expression, e.g. \"document.title\".") },
    positional: ["expression"],
    handler: (s, a) => s.evaluate(a.expression),
  }),

  def({
    name: "go_back",
    summary: "Go back in history",
    description: "Navigate back one entry in the active tab's history.",
    schema: {},
    mutating: true,
    handler: (s) => s.goBack(),
  }),

  def({
    name: "go_forward",
    summary: "Go forward in history",
    description: "Navigate forward one entry in the active tab's history.",
    schema: {},
    mutating: true,
    handler: (s) => s.goForward(),
  }),

  def({
    name: "reload",
    summary: "Reload the page",
    description: "Reload the active tab.",
    schema: {},
    mutating: true,
    handler: (s) => s.reload(),
  }),

  def({
    name: "list_tabs",
    summary: "List open tabs",
    description: "List open tabs with their index and URL. The active tab is marked with *.",
    schema: {},
    handler: (s) => s.listTabs(),
  }),

  def({
    name: "new_tab",
    summary: "Open a new tab",
    description: "Open a new tab and make it active, optionally navigating it to a URL.",
    schema: { url: z.string().optional().describe("URL to open in the new tab.") },
    positional: ["url"],
    mutating: true,
    handler: (s, a) => s.newTab(a.url),
  }),

  def({
    name: "select_tab",
    summary: "Switch to a tab by index",
    description: "Make the tab at the given index active. Indices come from list_tabs.",
    schema: { index: z.number().describe("Tab index from list_tabs.") },
    positional: ["index"],
    handler: (s, a) => s.selectTab(a.index),
  }),

  def({
    name: "close_tab",
    summary: "Close a tab",
    description: "Close a tab by index, or the active tab when no index is given.",
    schema: { index: z.number().optional().describe("Tab index. Defaults to the active tab.") },
    positional: ["index"],
    mutating: true,
    handler: (s, a) => s.closeTab(a.index),
  }),

  def({
    name: "list_secrets",
    summary: "List available credential names",
    description:
      "List the names of credentials in the local store. Only names are returned, never values — pass a name to fill_credential to use it.",
    schema: {},
    handler: async () => {
      const names = listSecretNames();
      return names.length
        ? `Available secret names (values are never shown):\n${names.map((n) => `- ${n}`).join("\n")}`
        : "No secrets configured. Add one with: agentbrowser secrets set <NAME> <value>";
    },
  }),

  def({
    name: "list_downloads",
    summary: "List files downloaded this session",
    description: "List files the page downloaded during this session, with the local path each was saved to.",
    schema: {},
    handler: (s) => s.listDownloads(),
  }),

  def({
    name: "reset_session",
    summary: "Clear cookies and start a clean session",
    description:
      "Discard all cookies, storage and tabs, and start a fresh empty browsing context. Use to log out fully or to start an unrelated task from a clean state.",
    schema: {},
    mutating: true,
    handler: (s) => s.reset(),
  }),
];

export const ACTIONS_BY_NAME = new Map(ACTIONS.map((a) => [a.name, a]));

/**
 * Runs an action with validation and audit logging applied uniformly, so the
 * MCP and CLI front-ends cannot drift apart in behaviour.
 */
export async function runAction(
  session: BrowserSession,
  name: string,
  rawArgs: Record<string, unknown>,
  via: "mcp" | "cli",
): Promise<ActionResult> {
  const action = ACTIONS_BY_NAME.get(name);
  if (!action) throw new Error(`Unknown action "${name}". Run 'agentbrowser help' to list actions.`);

  const parsed = z.object(action.schema).strict().parse(rawArgs);
  const started = Date.now();
  try {
    const out = await action.handler(session, parsed);
    const result: ActionResult = typeof out === "string" ? { text: out } : out;
    recordAction({ action: name, via, args: parsed as Record<string, unknown>, ok: true, ms: Date.now() - started });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordAction({ action: name, via, args: parsed as Record<string, unknown>, ok: false, ms: Date.now() - started, error: message });
    throw error;
  }
}
