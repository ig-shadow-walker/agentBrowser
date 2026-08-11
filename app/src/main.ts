import { invoke } from "@tauri-apps/api/core";

/**
 * Step 1 is the shell only: prove the app builds, launches, and can talk to
 * Rust. The tray lives in step 2 and the real secrets UI in step 3.
 */

async function init(): Promise<void> {
  const versionEl = document.querySelector<HTMLElement>("#version");
  const statusEl = document.querySelector<HTMLElement>("#status");

  try {
    const version = await invoke<string>("app_version");
    if (versionEl) versionEl.textContent = `v${version}`;
    // Reaching here means the webview reached Rust, which is the one thing
    // worth verifying at this stage.
    if (statusEl) statusEl.textContent = "App shell running.";
  } catch (error) {
    if (statusEl) {
      statusEl.textContent = `Could not reach the app backend: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }
}

window.addEventListener("DOMContentLoaded", () => void init());
