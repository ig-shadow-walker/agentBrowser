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

async function init(): Promise<void> {
  try {
    el("version").textContent = `v${await invoke<string>("app_version")}`;
  } catch {
    /* version is decoration; a failure here is not worth surfacing */
  }

  el<HTMLFormElement>("add-form").addEventListener("submit", (e) => void addSecret(e));
  await refreshStatus();
  await refreshSecrets();
}

window.addEventListener("DOMContentLoaded", () => void init());
