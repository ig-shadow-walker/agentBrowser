import { chromium } from "playwright";
import type { Browser } from "playwright";

/**
 * Finds a Chromium to drive.
 *
 * Playwright's own downloader runs the actual fetch in a forked helper process,
 * which does not exist inside a single-file compiled binary — so a fresh machine
 * cannot always self-install. Rather than reimplementing Playwright's CDN layout
 * (which changes between releases), we try each viable browser in turn and fall
 * back to a Chrome the user already has.
 */

export type BrowserChannel = "bundled" | "chrome" | "msedge";

const LAUNCH_ARGS = ["--disable-blink-features=AutomationControlled"];

/** Ordered by preference: a pinned Playwright build beats a moving system one. */
const CANDIDATES: BrowserChannel[] = ["bundled", "chrome", "msedge"];

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0] ?? message;
}

function isMissingBrowserError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Executable doesn't exist|Chromium distribution .* is not found|please run|Failed to launch/i.test(message);
}

export async function launchChromium(headed: boolean): Promise<Browser> {
  const forced = process.env.AGENTBROWSER_CHANNEL as BrowserChannel | undefined;
  const order = forced ? [forced] : CANDIDATES;
  const failures: string[] = [];

  for (const candidate of order) {
    try {
      const browser = await chromium.launch({
        headless: !headed,
        args: LAUNCH_ARGS,
        ...(candidate === "bundled" ? {} : { channel: candidate }),
      });
      return browser;
    } catch (error) {
      const message = firstLine(error);
      failures.push(`${candidate}: ${message.split("\n")[0]}`);
      if (!isMissingBrowserError(error)) throw error;
    }
  }

  throw new Error(
    [
      "No usable Chromium found.",
      "",
      "Fix with either:",
      "  agentbrowser install-browser        (downloads Playwright's pinned Chromium)",
      "  install Google Chrome               (agentBrowser will use it automatically)",
      "",
      "Tried:",
      ...failures.map((f) => `  - ${f}`),
    ].join("\n"),
  );
}

/** Reports which candidate would be used, for `doctor`. */
export async function probeChannels(): Promise<{ channel: BrowserChannel; ok: boolean; detail: string }[]> {
  const results: { channel: BrowserChannel; ok: boolean; detail: string }[] = [];
  for (const candidate of CANDIDATES) {
    try {
      const browser = await chromium.launch({
        headless: true,
        args: LAUNCH_ARGS,
        ...(candidate === "bundled" ? {} : { channel: candidate }),
      });
      const version = browser.version();
      await browser.close();
      results.push({ channel: candidate, ok: true, detail: `Chromium ${version}` });
    } catch (error) {
      results.push({ channel: candidate, ok: false, detail: firstLine(error) });
    }
  }
  return results;
}
