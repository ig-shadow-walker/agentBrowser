import { invoke } from "@tauri-apps/api/core";

/**
 * The panel is a thin face over the engine CLI. Every secret operation goes
 * through the same commands a user would type, so the app cannot hold a
 * different view of what is stored than the terminal does.
 */

interface EngineStatus {
  installed: boolean;
  version: string | null;
  path: string | null;
  /** "bundled" | "installed" | "dev" */
  source: string | null;
}

const el = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

let busy = false;

function showError(message: string): void {
  const box = el("error");
  box.textContent = message;
  box.hidden = false;
}

function clearError(): void {
  el("error").hidden = true;
}

async function refreshStatus(): Promise<void> {
  const dot = el("status-dot");
  const text = el("status-text");
  try {
    const status = await invoke<EngineStatus>("engine_status");
    if (status.installed) {
      dot.className = "dot ok";
      const version = status.version ? `v${status.version}` : "";
      // Only worth naming the source when it is *not* the copy inside this app,
      // since anything else means behaviour could differ from a clean install.
      const suffix =
        status.source === "installed" ? " — using your installed copy"
        : status.source === "dev" ? " — dev build"
        : "";
      text.textContent = `Engine ${version} ready${suffix}`.replace(/\s+/g, " ").trim();
      if (status.path) text.title = status.path;
    } else {
      dot.className = "dot bad";
      text.textContent = "Engine not found";
    }
  } catch (error) {
    dot.className = "dot bad";
    text.textContent = describe(error);
  }
}

function describe(error: unknown): string {
  if (typeof error === "string") return error;
  return error instanceof Error ? error.message : String(error);
}

async function refreshSecrets(): Promise<void> {
  const list = el<HTMLUListElement>("list");
  try {
    const names = await invoke<string[]>("secrets_list");
    list.replaceChildren();
    el("empty").hidden = names.length > 0;

    for (const name of names) {
      const row = document.createElement("li");
      row.className = "row";

      const label = document.createElement("span");
      label.className = "name";
      label.textContent = name;

      const remove = document.createElement("button");
      remove.className = "remove";
      remove.type = "button";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove ${name}`);
      remove.addEventListener("click", () => void deleteSecret(name, remove));

      row.append(label, remove);
      list.append(row);
    }
  } catch (error) {
    el("empty").hidden = true;
    showError(describe(error));
  }
}

async function deleteSecret(name: string, button: HTMLButtonElement): Promise<void> {
  if (busy) return;
  // No confirmation dialog: a removed credential is re-addable in seconds, and
  // a modal for every delete would be more annoying than the mistake it prevents.
  busy = true;
  button.disabled = true;
  button.textContent = "Removing…";
  clearError();
  try {
    await invoke("secrets_remove", { name });
    await refreshSecrets();
  } catch (error) {
    showError(describe(error));
    button.disabled = false;
    button.textContent = "Remove";
  } finally {
    busy = false;
  }
}

async function addSecret(event: Event): Promise<void> {
  event.preventDefault();
  if (busy) return;

  const nameInput = el<HTMLInputElement>("secret-name");
  const valueInput = el<HTMLInputElement>("secret-value");
  const button = el<HTMLButtonElement>("add-button");

  const name = nameInput.value.trim();
  const value = valueInput.value;

  if (!name) {
    showError("Give the credential a name.");
    nameInput.focus();
    return;
  }
  if (!value) {
    showError("Give the credential a value.");
    valueInput.focus();
    return;
  }

  busy = true;
  button.disabled = true;
  button.textContent = "Saving…";
  clearError();

  try {
    await invoke("secrets_set", { name, value });
    nameInput.value = "";
    valueInput.value = "";
    await refreshSecrets();
    nameInput.focus();
  } catch (error) {
    showError(describe(error));
  } finally {
    busy = false;
    button.disabled = false;
    button.textContent = "Save";
  }
}

interface SetupStatus {
  bundled_version: string | null;
  installed_version: string | null;
  needs_setup: boolean;
  /** "missing" | "different" */
  reason: string | null;
}

async function refreshSetup(): Promise<void> {
  const box = el("setup");
  try {
    const status = await invoke<SetupStatus>("setup_status");
    if (!status.needs_setup) {
      box.hidden = true;
      return;
    }
    // Distinguish "never set up" from "set up, but stale" — the second is the
    // dangerous one, because an agent would silently run the older engine.
    // Note the version numbers can match while the binaries differ, so the
    // wording avoids claiming the versions are different.
    if (status.reason === "different") {
      const { installed_version: installed, bundled_version: bundled } = status;
      const versions =
        !installed || !bundled
          ? null
          : installed === bundled
            ? `both report v${bundled}`
            : `v${installed} vs v${bundled}`;
      el("setup-text").textContent =
        `Your agents are running a different build of the engine than this app ships` +
        `${versions ? ` (${versions})` : ""}. Update to keep them in step.`;
      el<HTMLButtonElement>("setup-button").textContent = "Update";
    } else {
      el("setup-text").textContent =
        "Connect agentBrowser to Claude Code and Codex. This also downloads a browser if you need one.";
      el<HTMLButtonElement>("setup-button").textContent = "Set up";
    }
    box.hidden = false;
  } catch {
    box.hidden = true;
  }
}

async function doSetup(): Promise<void> {
  if (busy) return;
  const button = el<HTMLButtonElement>("setup-button");
  const log = el<HTMLPreElement>("setup-log");

  busy = true;
  button.disabled = true;
  button.textContent = "Working…";
  log.hidden = true;
  clearError();

  try {
    const output = await invoke<string>("run_setup");
    // Strip ANSI colour: the CLI writes for a terminal, not a webview.
    log.textContent = output.replace(/\x1b\[[0-9;]*m/g, "").trim();
    log.hidden = false;
    await refreshStatus();
    await refreshSetup();
    await refreshSecrets();
  } catch (error) {
    showError(describe(error));
    button.disabled = false;
    button.textContent = "Try again";
  } finally {
    busy = false;
  }
}

async function initAutostart(): Promise<void> {
  const box = el<HTMLInputElement>("autostart");
  try {
    box.checked = await invoke<boolean>("autostart_enabled");
  } catch {
    box.disabled = true;
    return;
  }
  box.addEventListener("change", async () => {
    const wanted = box.checked;
    box.disabled = true;
    try {
      await invoke("autostart_set", { enabled: wanted });
    } catch (error) {
      // Put the checkbox back rather than showing a state that is not real.
      box.checked = !wanted;
      showError(describe(error));
    } finally {
      box.disabled = false;
    }
  });
}

async function init(): Promise<void> {
  try {
    el("version").textContent = `v${await invoke<string>("app_version")}`;
  } catch {
    /* version is decoration; a failure here is not worth surfacing */
  }

  el<HTMLFormElement>("add-form").addEventListener("submit", (e) => void addSecret(e));
  el("setup-button").addEventListener("click", () => void doSetup());

  await refreshStatus();
  await refreshSetup();
  await initAutostart();
  await refreshSecrets();
}

window.addEventListener("DOMContentLoaded", () => void init());
