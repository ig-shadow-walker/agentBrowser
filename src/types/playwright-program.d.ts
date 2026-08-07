/**
 * `playwright/lib/program` is a published export but ships no types. We use it
 * so the compiled binary can install its own browser with Playwright's real
 * downloader, rather than reimplementing CDN paths and revision pinning in a
 * shell script that would silently rot on every Playwright upgrade.
 */
declare module "playwright/lib/program" {
  export const program: {
    parseAsync(args: string[], options?: { from?: "user" | "node" | "electron" }): Promise<unknown>;
  };
}
