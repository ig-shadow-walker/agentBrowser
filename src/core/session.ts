import fs from "node:fs";
import path from "node:path";
import type { Browser, BrowserContext, Dialog, Download, Frame, Locator, Page } from "playwright";
import { launchChromium } from "./launch.js";
import { collectSnapshot, formatSnapshot, type FrameSnapshot, type SnapshotFilter } from "./snapshot.js";
import { getSecret } from "./secrets.js";
import { PATHS, ensureDir } from "./paths.js";

export interface SessionOptions {
  headed?: boolean;
  viewport?: { width: number; height: number };
  timeoutMs?: number;
  /** What to do when the page raises alert/confirm/prompt. */
  dialogPolicy?: "accept" | "dismiss";
}

interface FrameRecord {
  docId: string;
  url: string;
}

interface PageState {
  frames: FrameRecord[];
}

const REF_PATTERN = /^(?:f(\d+))?(e\d+)$/;
const DEFAULT_TIMEOUT = 30_000;
const MAX_SNAPSHOT_NODES = 4000;

export class SessionError extends Error {}

/**
 * Owns one headless browser and everything the agent can do with it.
 *
 * Deliberately *not* persistent: a session starts with a clean context and no
 * cookies, so every task authenticates from scratch. `reset()` returns to that
 * clean state without paying to relaunch the browser process.
 */
export class BrowserSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private pages: Page[] = [];
  private activeIndex = 0;
  private pageState = new WeakMap<Page, PageState>();
  private pendingDialogs: string[] = [];
  private downloads: { path: string; suggestedName: string; url: string }[] = [];
  private options: Required<SessionOptions>;

  constructor(options: SessionOptions = {}) {
    this.options = {
      headed: options.headed ?? process.env.AGENTBROWSER_HEADED === "1",
      viewport: options.viewport ?? { width: 1280, height: 800 },
      timeoutMs: options.timeoutMs ?? Number(process.env.AGENTBROWSER_TIMEOUT_MS ?? DEFAULT_TIMEOUT),
      dialogPolicy: options.dialogPolicy ?? ((process.env.AGENTBROWSER_DIALOG_POLICY as "accept" | "dismiss") || "accept"),
    };
  }

  // ---------------------------------------------------------------- lifecycle

  private async ensureStarted(): Promise<BrowserContext> {
    if (this.context) return this.context;

    this.browser ??= await launchChromium(this.options.headed);

    ensureDir(PATHS.downloadsDir);
    this.context = await this.browser.newContext({
      viewport: this.options.viewport,
      acceptDownloads: true,
      ignoreHTTPSErrors: true,
    });
    this.context.setDefaultTimeout(this.options.timeoutMs);
    this.context.setDefaultNavigationTimeout(this.options.timeoutMs);

    this.context.on("page", (page) => this.trackPage(page));
    const first = await this.context.newPage();
    this.trackPage(first);
    this.activeIndex = 0;
    return this.context;
  }

  private trackPage(page: Page): void {
    if (this.pages.includes(page)) return;
    this.pages.push(page);

    page.on("dialog", (dialog: Dialog) => void this.onDialog(dialog));
    page.on("download", (download: Download) => void this.onDownload(download));
    page.on("close", () => {
      const idx = this.pages.indexOf(page);
      if (idx !== -1) {
        this.pages.splice(idx, 1);
        if (this.activeIndex >= this.pages.length) this.activeIndex = Math.max(0, this.pages.length - 1);
      }
    });
  }

  private async onDialog(dialog: Dialog): Promise<void> {
    this.pendingDialogs.push(`${dialog.type()}: ${dialog.message()}`);
    try {
      if (this.options.dialogPolicy === "accept") await dialog.accept();
      else await dialog.dismiss();
    } catch {
      /* dialog may already be gone */
    }
  }

  private async onDownload(download: Download): Promise<void> {
    try {
      const dir = ensureDir(PATHS.downloadsDir);
      const target = path.join(dir, `${Date.now()}-${download.suggestedFilename()}`);
      await download.saveAs(target);
      this.downloads.push({ path: target, suggestedName: download.suggestedFilename(), url: download.url() });
    } catch {
      /* download may have been cancelled */
    }
  }

  /** Drops all cookies/storage and starts a clean context, keeping the browser warm. */
  async reset(): Promise<string> {
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
    this.pages = [];
    this.activeIndex = 0;
    this.pendingDialogs = [];
    this.downloads = [];
    await this.ensureStarted();
    return "Session reset. New empty context with no cookies or storage.";
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.context = null;
    this.browser = null;
    this.pages = [];
  }

  // ------------------------------------------------------------------- tabs

  private async activePage(): Promise<Page> {
    await this.ensureStarted();
    if (this.pages.length === 0) {
      const page = await this.context!.newPage();
      this.trackPage(page);
      this.activeIndex = 0;
    }
    const page = this.pages[Math.min(this.activeIndex, this.pages.length - 1)];
    if (!page) throw new SessionError("No open page.");
    return page;
  }

  async listTabs(): Promise<string> {
    await this.ensureStarted();
    if (this.pages.length === 0) return "No open tabs.";
    const rows = await Promise.all(
      this.pages.map(async (p, i) => {
        const title = await p.title().catch(() => "");
        return `${i === this.activeIndex ? "*" : " "} [${i}] ${p.url()}${title ? `  — ${title}` : ""}`;
      }),
    );
    return rows.join("\n");
  }

  async newTab(url?: string): Promise<string> {
    const context = await this.ensureStarted();
    const page = await context.newPage();
    this.trackPage(page);
    this.activeIndex = this.pages.indexOf(page);
    if (url) await page.goto(url, { waitUntil: "domcontentloaded" });
    return `Opened tab [${this.activeIndex}]${url ? ` at ${page.url()}` : ""}.`;
  }

  async selectTab(index: number): Promise<string> {
    await this.ensureStarted();
    if (index < 0 || index >= this.pages.length) {
      throw new SessionError(`No tab at index ${index}. Open tabs: 0..${this.pages.length - 1}.`);
    }
    this.activeIndex = index;
    const page = this.pages[index]!;
    await page.bringToFront().catch(() => {});
    return `Switched to tab [${index}] ${page.url()}`;
  }

  async closeTab(index?: number): Promise<string> {
    await this.ensureStarted();
    const idx = index ?? this.activeIndex;
    const page = this.pages[idx];
    if (!page) throw new SessionError(`No tab at index ${idx}.`);
    await page.close();
    return `Closed tab [${idx}].`;
  }

  // -------------------------------------------------------------- navigation

  async navigate(url: string, waitUntil: "load" | "domcontentloaded" | "networkidle" = "domcontentloaded"): Promise<string> {
    const page = await this.activePage();
    const normalized = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) ? url : `https://${url}`;
    const response = await page.goto(normalized, { waitUntil });
    const status = response ? `${response.status()} ${response.statusText()}`.trim() : "no response";
    const title = await page.title().catch(() => "");
    return this.withNotices(`Navigated to ${page.url()} (${status})${title ? `\nTitle: ${title}` : ""}`);
  }

  async goBack(): Promise<string> {
    const page = await this.activePage();
    await page.goBack({ waitUntil: "domcontentloaded" });
    return this.withNotices(`Went back to ${page.url()}`);
  }

  async goForward(): Promise<string> {
    const page = await this.activePage();
    await page.goForward({ waitUntil: "domcontentloaded" });
    return this.withNotices(`Went forward to ${page.url()}`);
  }

  async reload(): Promise<string> {
    const page = await this.activePage();
    await page.reload({ waitUntil: "domcontentloaded" });
    return this.withNotices(`Reloaded ${page.url()}`);
  }

  // --------------------------------------------------------------- perception

  async snapshot(filter: SnapshotFilter = "all"): Promise<string> {
    const page = await this.activePage();
    await page.waitForLoadState("domcontentloaded").catch(() => {});

    const frames = page.frames();
    const records: FrameRecord[] = [];
    const sections: string[] = [];

    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i]!;
      let snap: FrameSnapshot;
      try {
        snap = await frame.evaluate(collectSnapshot, { filter, maxNodes: MAX_SNAPSHOT_NODES });
      } catch {
        // Detached or still-navigating frames are expected; record a placeholder
        // so frame indices stay aligned with page.frames().
        records.push({ docId: "", url: frame.url() });
        continue;
      }
      records.push({ docId: snap.docId, url: snap.url });
      const prefix = i === 0 ? "" : `f${i}`;
      const body = formatSnapshot(snap, prefix);
      if (i === 0) {
        sections.push(`Page: ${snap.url}\nTitle: ${snap.title}\n\n${body}`);
      } else if (body.trim()) {
        sections.push(`\n--- iframe [f${i}] ${snap.url} ---\n${body}`);
      }
    }

    this.pageState.set(page, { frames: records });
    return this.withNotices(sections.join("\n"));
  }

  async screenshot(fullPage = false, ref?: string): Promise<{ text: string; base64: string; savedTo: string }> {
    const page = await this.activePage();
    const dir = ensureDir(PATHS.screenshotsDir);
    const savedTo = path.join(dir, `${Date.now()}.png`);

    let buffer: Buffer;
    if (ref) {
      const locator = await this.resolve(ref);
      buffer = await locator.screenshot();
    } else {
      buffer = await page.screenshot({ fullPage });
    }
    fs.writeFileSync(savedTo, buffer);
    return {
      text: this.withNotices(`Screenshot of ${page.url()} saved to ${savedTo}`),
      base64: buffer.toString("base64"),
      savedTo,
    };
  }

  async getText(maxChars = 20_000): Promise<string> {
    const page = await this.activePage();
    const text = await page.evaluate(() => {
      const main = document.querySelector("main") || document.querySelector("article") || document.body;
      return main ? (main as HTMLElement).innerText : "";
    });
    const trimmed = text.replace(/\n{3,}/g, "\n\n").trim();
    const clipped = trimmed.length > maxChars ? trimmed.slice(0, maxChars) + `\n… (truncated, ${trimmed.length} chars total)` : trimmed;
    return this.withNotices(`Page: ${page.url()}\n\n${clipped}`);
  }

  async evaluate(expression: string): Promise<string> {
    const page = await this.activePage();
    // Accept both an expression ("document.title") and a function body.
    const result = await page.evaluate((expr: string) => {
      // eslint-disable-next-line no-new-func
      const fn = new Function(`return (${expr})`);
      try {
        return fn();
      } catch {
        const stmt = new Function(expr);
        return stmt();
      }
    }, expression);
    return this.withNotices(typeof result === "string" ? result : JSON.stringify(result, null, 2) ?? String(result));
  }

  // ------------------------------------------------------------ ref plumbing

  /**
   * Turns an agent-supplied ref into a Playwright locator, refusing refs that
   * were minted for a document the page has since navigated away from.
   */
  private async resolve(ref: string): Promise<Locator> {
    const match = REF_PATTERN.exec(ref.trim());
    if (!match) {
      throw new SessionError(`Malformed ref "${ref}". Expected e.g. "e12", or "f1e12" for an element inside iframe 1.`);
    }
    const frameIndex = match[1] ? Number(match[1]) : 0;
    const localRef = match[2]!;

    const page = await this.activePage();
    const state = this.pageState.get(page);
    if (!state) {
      throw new SessionError("No snapshot has been taken of this page yet. Call snapshot() first to get element refs.");
    }
    const record = state.frames[frameIndex];
    if (!record) {
      throw new SessionError(`Ref "${ref}" points at frame ${frameIndex}, which no longer exists. Call snapshot() again.`);
    }

    const frames = page.frames();
    const frame: Frame | undefined = frames[frameIndex];
    if (!frame) {
      throw new SessionError(`Ref "${ref}" points at frame ${frameIndex}, which no longer exists. Call snapshot() again.`);
    }

    // The doc id changes on every document load, so a mismatch means these refs
    // describe a page that is gone. Acting on them would click a wrong element.
    const currentDocId = await frame
      .evaluate(() => (window as unknown as { __abDocId?: string }).__abDocId ?? "")
      .catch(() => "");
    if (!currentDocId || currentDocId !== record.docId) {
      throw new SessionError(
        `Refs are stale — the page changed since the last snapshot (was ${record.url}, now ${frame.url()}). Call snapshot() again to get fresh refs.`,
      );
    }

    const locator = frame.locator(`[data-ab-ref="${localRef}"]`);
    const count = await locator.count();
    if (count === 0) {
      throw new SessionError(`Ref "${ref}" no longer matches any element. Call snapshot() again.`);
    }
    return locator.first();
  }

  private async describe(locator: Locator): Promise<string> {
    try {
      const info = await locator.evaluate((el: Element) => {
        const tag = el.tagName.toLowerCase();
        const label =
          el.getAttribute("aria-label") ||
          (el as HTMLInputElement).placeholder ||
          (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
        return label ? `${tag} "${label}"` : tag;
      });
      return info;
    } catch {
      return "element";
    }
  }

  // ------------------------------------------------------------------ actions

  async click(ref: string, opts: { button?: "left" | "right" | "middle"; clickCount?: number; force?: boolean } = {}): Promise<string> {
    const locator = await this.resolve(ref);
    const what = await this.describe(locator);
    const page = await this.activePage();
    const before = page.url();

    await locator.click({
      button: opts.button ?? "left",
      clickCount: opts.clickCount ?? 1,
      force: opts.force ?? false,
    });
    await page.waitForLoadState("domcontentloaded").catch(() => {});

    const after = page.url();
    const moved = before !== after ? `\nPage navigated to ${after} — previous refs are stale, call snapshot() again.` : "";
    return this.withNotices(`Clicked ${what} [${ref}].${moved}`);
  }

  async type(ref: string, text: string, opts: { submit?: boolean; clear?: boolean; delayMs?: number } = {}): Promise<string> {
    const locator = await this.resolve(ref);
    const what = await this.describe(locator);
    const page = await this.activePage();

    if (opts.clear !== false) {
      await locator.fill("");
    }
    if (opts.delayMs && opts.delayMs > 0) {
      await locator.pressSequentially(text, { delay: opts.delayMs });
    } else {
      await locator.fill(text);
    }
    if (opts.submit) {
      await locator.press("Enter");
      await page.waitForLoadState("domcontentloaded").catch(() => {});
    }
    return this.withNotices(`Typed into ${what} [${ref}]${opts.submit ? " and pressed Enter" : ""}.`);
  }

  /**
   * Types a stored credential into a field. The value is read from the local
   * secrets store inside the engine and written straight to the page — it is
   * never returned to the caller, so it never enters the agent's context or
   * the audit log.
   */
  async fillCredential(ref: string, secretName: string, opts: { submit?: boolean } = {}): Promise<string> {
    const value = getSecret(secretName);
    if (value === undefined) {
      throw new SessionError(
        `No secret named "${secretName}". Add it with: agentbrowser secrets set ${secretName} <value>   (known names: ${
          (await import("./secrets.js")).listSecretNames().join(", ") || "none"
        })`,
      );
    }
    const locator = await this.resolve(ref);
    const what = await this.describe(locator);
    const page = await this.activePage();

    await locator.fill("");
    await locator.fill(value);
    if (opts.submit) {
      await locator.press("Enter");
      await page.waitForLoadState("domcontentloaded").catch(() => {});
    }
    return this.withNotices(`Filled ${what} [${ref}] with secret "${secretName}" (value not shown)${opts.submit ? " and pressed Enter" : ""}.`);
  }

  /**
   * The capability that motivated this whole tool. Browsers gate the native file
   * picker behind a real user gesture, so page-level JS automation can't set a
   * file input. Driving Chromium over CDP has no such restriction.
   *
   * Handles both a real `<input type=file>` and the common pattern of a styled
   * button that opens a hidden picker.
   */
  async uploadFile(ref: string, filePaths: string[]): Promise<string> {
    const resolved = filePaths.map((p) => {
      const abs = path.resolve(p.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
      if (!fs.existsSync(abs)) throw new SessionError(`File not found: ${abs}`);
      if (!fs.statSync(abs).isFile()) throw new SessionError(`Not a regular file: ${abs}`);
      return abs;
    });
    if (resolved.length === 0) throw new SessionError("No files given to upload.");

    const locator = await this.resolve(ref);
    const what = await this.describe(locator);
    const page = await this.activePage();

    const isFileInput = await locator.evaluate(
      (el: Element) => el.tagName === "INPUT" && (el as HTMLInputElement).type === "file",
    );

    if (isFileInput) {
      await locator.setInputFiles(resolved);
    } else {
      // Styled trigger: click it and satisfy the file chooser it opens.
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: this.options.timeoutMs }),
        locator.click(),
      ]);
      await chooser.setFiles(resolved);
    }

    const names = resolved.map((p) => path.basename(p)).join(", ");
    return this.withNotices(`Set ${resolved.length} file(s) on ${what} [${ref}]: ${names}`);
  }

  async select(ref: string, values: string[]): Promise<string> {
    const locator = await this.resolve(ref);
    const what = await this.describe(locator);
    // Playwright matches by value, then label — try value first, fall back to label.
    try {
      await locator.selectOption(values);
    } catch {
      await locator.selectOption(values.map((label) => ({ label })));
    }
    return this.withNotices(`Selected ${values.join(", ")} in ${what} [${ref}].`);
  }

  async check(ref: string, checked: boolean): Promise<string> {
    const locator = await this.resolve(ref);
    const what = await this.describe(locator);
    if (checked) await locator.check();
    else await locator.uncheck();
    return this.withNotices(`${checked ? "Checked" : "Unchecked"} ${what} [${ref}].`);
  }

  async hover(ref: string): Promise<string> {
    const locator = await this.resolve(ref);
    const what = await this.describe(locator);
    await locator.hover();
    return this.withNotices(`Hovered ${what} [${ref}].`);
  }

  async pressKey(key: string, ref?: string): Promise<string> {
    const page = await this.activePage();
    if (ref) {
      const locator = await this.resolve(ref);
      await locator.press(key);
    } else {
      await page.keyboard.press(key);
    }
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    return this.withNotices(`Pressed ${key}${ref ? ` on [${ref}]` : ""}.`);
  }

  async scroll(direction: "up" | "down" | "left" | "right", amount = 600, ref?: string): Promise<string> {
    const page = await this.activePage();
    if (ref) {
      const locator = await this.resolve(ref);
      await locator.scrollIntoViewIfNeeded();
      return this.withNotices(`Scrolled [${ref}] into view.`);
    }
    const [dx, dy] =
      direction === "down" ? [0, amount] :
      direction === "up" ? [0, -amount] :
      direction === "right" ? [amount, 0] : [-amount, 0];
    await page.mouse.wheel(dx, dy);
    return this.withNotices(`Scrolled ${direction} by ${amount}px.`);
  }

  async waitFor(opts: { text?: string; ms?: number; state?: "load" | "domcontentloaded" | "networkidle" }): Promise<string> {
    const page = await this.activePage();
    if (opts.text) {
      await page.getByText(opts.text, { exact: false }).first().waitFor({ state: "visible" });
      return this.withNotices(`Text "${opts.text}" is now visible.`);
    }
    if (opts.state) {
      await page.waitForLoadState(opts.state);
      return this.withNotices(`Page reached "${opts.state}".`);
    }
    const ms = opts.ms ?? 1000;
    await page.waitForTimeout(ms);
    return this.withNotices(`Waited ${ms}ms.`);
  }

  listDownloads(): string {
    if (this.downloads.length === 0) return "No files downloaded this session.";
    return this.downloads.map((d, i) => `[${i}] ${d.suggestedName} → ${d.path}`).join("\n");
  }

  // ------------------------------------------------------------------ notices

  /**
   * Surfaces out-of-band events (dialogs, downloads) alongside whatever action
   * result the agent asked for, so they can't pass by unnoticed.
   */
  private withNotices(text: string): string {
    const notices: string[] = [];
    if (this.pendingDialogs.length) {
      const policy = this.options.dialogPolicy === "accept" ? "accepted" : "dismissed";
      for (const d of this.pendingDialogs) notices.push(`[dialog ${policy}] ${d}`);
      this.pendingDialogs = [];
    }
    return notices.length ? `${text}\n\n${notices.join("\n")}` : text;
  }
}
