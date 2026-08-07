/**
 * Accessibility-style page snapshot with stable element refs.
 *
 * The agent's primary way of "seeing" a page. We walk the DOM in-page, stamp
 * each meaningful element with a `data-ab-ref` attribute, and return a compact
 * indented tree of role/name pairs. The agent then acts by ref (`click("e12")`)
 * rather than by CSS selector or pixel coordinate.
 *
 * Refs are reused across snapshots of the same document, so an agent can take a
 * snapshot once and issue several actions against it. Each document also gets a
 * random `docId`; the session refuses to act on refs minted for a different
 * document, which is what stops a stale `e12` from clicking the wrong element
 * after a navigation or re-render.
 */

export interface SnapshotNode {
  ref?: string;
  role: string;
  name?: string;
  value?: string;
  extra?: string[];
  children: SnapshotNode[];
}

export interface FrameSnapshot {
  docId: string;
  url: string;
  title: string;
  truncated: boolean;
  root: SnapshotNode;
}

export type SnapshotFilter = "interactive" | "all";

/**
 * Runs inside the page. Must be fully self-contained — it is serialized and
 * evaluated in the browser, so it cannot close over anything from Node.
 */
export function collectSnapshot(options: { filter: SnapshotFilter; maxNodes: number }): FrameSnapshot {
  const { filter, maxNodes } = options;

  const w = window as unknown as { __abRefCounter?: number; __abDocId?: string };
  if (!w.__abDocId) {
    w.__abDocId = Math.random().toString(36).slice(2, 8);
    w.__abRefCounter = 0;
  }
  const docId = w.__abDocId;

  let nodeCount = 0;
  let truncated = false;

  const INTERACTIVE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY", "OPTION"]);
  const INTERACTIVE_ROLES = new Set([
    "button", "link", "checkbox", "radio", "textbox", "combobox", "listbox", "option",
    "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "switch", "slider",
    "searchbox", "spinbutton", "treeitem",
  ]);
  const STRUCTURAL_ROLES = new Set([
    "heading", "dialog", "alert", "alertdialog", "status", "navigation", "main",
    "form", "table", "row", "cell", "columnheader", "rowheader", "list", "listitem",
    "tablist", "tabpanel", "article", "banner", "contentinfo", "region", "img",
  ]);
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "TITLE", "SVG", "PATH"]);

  function isVisible(el: Element): boolean {
    if (!(el instanceof HTMLElement) && !(el instanceof SVGElement)) return true;
    if (el instanceof HTMLElement && el.hidden) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    // An element can legitimately have no box (e.g. a wrapper of floated kids),
    // so only treat "no rects AND no children" as invisible.
    if (el.getClientRects().length === 0 && el.children.length === 0) return false;
    return true;
  }

  function tagRole(el: Element): string {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.trim().split(/\s+/)[0] || "generic";

    const tag = el.tagName;
    switch (tag) {
      case "A":
        return el.hasAttribute("href") ? "link" : "generic";
      case "BUTTON":
        return "button";
      case "SELECT":
        return el.hasAttribute("multiple") ? "listbox" : "combobox";
      case "TEXTAREA":
        return "textbox";
      case "OPTION":
        return "option";
      case "SUMMARY":
        return "button";
      case "IMG":
        return "img";
      case "H1": case "H2": case "H3": case "H4": case "H5": case "H6":
        return "heading";
      case "NAV": return "navigation";
      case "MAIN": return "main";
      case "FORM": return "form";
      case "TABLE": return "table";
      case "TR": return "row";
      case "TD": return "cell";
      case "TH": return "columnheader";
      case "UL": case "OL": return "list";
      case "LI": return "listitem";
      case "DIALOG": return "dialog";
      case "IFRAME": return "iframe";
      case "LABEL": return "label";
      case "INPUT": {
        const type = ((el as HTMLInputElement).type || "text").toLowerCase();
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "file") return "file-input";
        if (type === "submit" || type === "button" || type === "reset" || type === "image") return "button";
        if (type === "range") return "slider";
        if (type === "number") return "spinbutton";
        if (type === "search") return "searchbox";
        if (type === "hidden") return "hidden";
        return "textbox";
      }
      default:
        return "generic";
    }
  }

  function textOf(el: Element, limit = 120): string {
    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    return text.length > limit ? text.slice(0, limit) + "…" : text;
  }

  function accessibleName(el: Element, role: string): string {
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const parts: string[] = [];
      for (const id of labelledBy.split(/\s+/)) {
        const target = document.getElementById(id);
        if (target) parts.push(textOf(target, 60));
      }
      const joined = parts.filter(Boolean).join(" ").trim();
      if (joined) return joined;
    }

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      if (el.id) {
        const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (label) {
          const t = textOf(label, 80);
          if (t) return t;
        }
      }
      const ancestorLabel = el.closest("label");
      if (ancestorLabel) {
        const t = textOf(ancestorLabel, 80);
        if (t) return t;
      }
      const placeholder = el.getAttribute("placeholder");
      if (placeholder && placeholder.trim()) return placeholder.trim();
      if (el instanceof HTMLInputElement && (el.type === "submit" || el.type === "button") && el.value) return el.value;
      const name = el.getAttribute("name");
      if (name) return name;
    }

    if (el instanceof HTMLImageElement) {
      const alt = el.getAttribute("alt");
      if (alt !== null) return alt.trim();
    }

    const title = el.getAttribute("title");
    if (title && title.trim()) return title.trim();

    // For leaf-ish interactive/structural nodes the visible text is the name.
    if (INTERACTIVE_ROLES.has(role) || role === "heading" || role === "label" || role === "button" || role === "link") {
      return textOf(el, 120);
    }
    return "";
  }

  function stateOf(el: Element, role: string): string[] {
    const extra: string[] = [];

    if (el instanceof HTMLAnchorElement) {
      const href = el.getAttribute("href");
      if (href && href !== "#") extra.push(`url=${href.length > 100 ? href.slice(0, 100) + "…" : href}`);
    }
    if (el instanceof HTMLElement && el.tagName === "IFRAME") {
      const src = el.getAttribute("src");
      if (src) extra.push(`src=${src.length > 100 ? src.slice(0, 100) + "…" : src}`);
    }

    const disabled =
      (el as HTMLInputElement).disabled === true ||
      el.getAttribute("aria-disabled") === "true";
    if (disabled) extra.push("disabled");

    if (el instanceof HTMLInputElement) {
      if (el.type === "checkbox" || el.type === "radio") {
        extra.push(el.checked ? "checked" : "unchecked");
      }
      if (el.required) extra.push("required");
      if (el.readOnly) extra.push("readonly");
      if (el.type === "file") {
        extra.push(el.multiple ? "accepts-multiple" : "single-file");
        if (el.accept) extra.push(`accept=${el.accept}`);
        const n = el.files ? el.files.length : 0;
        if (n > 0) extra.push(`${n} file(s) selected`);
      }
    }
    if (el instanceof HTMLTextAreaElement && el.required) extra.push("required");

    const expanded = el.getAttribute("aria-expanded");
    if (expanded) extra.push(`expanded=${expanded}`);
    const selected = el.getAttribute("aria-selected");
    if (selected === "true") extra.push("selected");
    const checkedAttr = el.getAttribute("aria-checked");
    if (checkedAttr && !(el instanceof HTMLInputElement)) extra.push(`checked=${checkedAttr}`);
    if (role === "heading") {
      const level = el.getAttribute("aria-level") || (/^H([1-6])$/.exec(el.tagName)?.[1] ?? "");
      if (level) extra.push(`level=${level}`);
    }
    return extra;
  }

  function valueOf(el: Element): string | undefined {
    if (el instanceof HTMLInputElement) {
      // Never echo a password back to the agent, even if it typed it.
      if (el.type === "password") return el.value ? "«hidden»" : undefined;
      if (el.type === "checkbox" || el.type === "radio" || el.type === "file") return undefined;
      return el.value || undefined;
    }
    if (el instanceof HTMLTextAreaElement) return el.value || undefined;
    if (el instanceof HTMLSelectElement) {
      const opt = el.selectedOptions[0];
      return opt ? opt.label || opt.value : undefined;
    }
    return undefined;
  }

  function isInteractive(el: Element, role: string): boolean {
    if (INTERACTIVE_ROLES.has(role) || role === "file-input") return true;
    if (INTERACTIVE_TAGS.has(el.tagName)) return true;
    if (el instanceof HTMLElement) {
      if (el.isContentEditable) return true;
      if (el.hasAttribute("onclick")) return true;
      const tabindex = el.getAttribute("tabindex");
      if (tabindex !== null && tabindex !== "-1") return true;
      const cursor = window.getComputedStyle(el).cursor;
      if (cursor === "pointer" && el.children.length === 0) return true;
    }
    return false;
  }

  function assignRef(el: Element): string {
    const existing = el.getAttribute("data-ab-ref");
    if (existing) return existing;
    w.__abRefCounter = (w.__abRefCounter ?? 0) + 1;
    const ref = `e${w.__abRefCounter}`;
    el.setAttribute("data-ab-ref", ref);
    return ref;
  }

  function walk(el: Element): SnapshotNode | null {
    if (SKIP_TAGS.has(el.tagName)) return null;
    if (nodeCount >= maxNodes) {
      truncated = true;
      return null;
    }
    if (!isVisible(el)) return null;

    const role = tagRole(el);
    if (role === "hidden") return null;

    const interactive = isInteractive(el, role);
    const structural = STRUCTURAL_ROLES.has(role);

    const children: SnapshotNode[] = [];
    for (const child of Array.from(el.children)) {
      const node = walk(child);
      if (node) children.push(node);
    }

    // A text-only leaf still carries meaning (labels, paragraphs, table cells).
    const ownText =
      children.length === 0 ? textOf(el, 200) : directTextOf(el);

    const include = interactive || structural || (ownText.length > 0);
    if (!include) {
      // Collapse meaningless wrappers so the tree stays shallow and readable.
      if (children.length === 1) return children[0] ?? null;
      if (children.length === 0) return null;
      return { role: "group", children, ...( {} ) };
    }

    nodeCount++;
    const name = accessibleName(el, role);
    const node: SnapshotNode = {
      role: interactive || structural ? role : "text",
      children,
    };
    if (interactive) node.ref = assignRef(el);
    const label = name || (children.length === 0 ? ownText : "");
    if (label) node.name = label;
    const value = valueOf(el);
    if (value !== undefined) node.value = value;
    const extra = stateOf(el, role);
    if (extra.length) node.extra = extra;
    return node;
  }

  function directTextOf(el: Element): string {
    let out = "";
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3) out += child.nodeValue || "";
    }
    return out.replace(/\s+/g, " ").trim();
  }

  function prune(node: SnapshotNode): SnapshotNode | null {
    const kept: SnapshotNode[] = [];
    for (const child of node.children) {
      const p = prune(child);
      if (p) kept.push(p);
    }
    node.children = kept;
    if (node.ref) return node;
    if (kept.length > 0) return node;
    return null;
  }

  const bodyNode = document.body ? walk(document.body) : null;
  let root: SnapshotNode = bodyNode ?? { role: "document", children: [] };
  if (filter === "interactive") {
    root = prune(root) ?? { role: "document", children: [] };
  }

  return {
    docId,
    url: location.href,
    title: document.title,
    truncated,
    root,
  };
}

/** Renders a frame snapshot as the indented text the agent actually reads. */
export function formatSnapshot(snap: FrameSnapshot, refPrefix = ""): string {
  const lines: string[] = [];

  function emit(node: SnapshotNode, depth: number): void {
    // The synthetic root/group wrappers add no information; flatten them.
    const isWrapper = !node.ref && !node.name && (node.role === "group" || node.role === "document" || node.role === "generic");
    if (!isWrapper) {
      const parts: string[] = [node.role];
      if (node.name) parts.push(JSON.stringify(node.name));
      if (node.ref) parts.push(`[ref=${refPrefix}${node.ref}]`);
      if (node.value !== undefined) parts.push(`value=${JSON.stringify(node.value)}`);
      if (node.extra?.length) parts.push(`(${node.extra.join(", ")})`);
      lines.push("  ".repeat(depth) + "- " + parts.join(" "));
    }
    const nextDepth = isWrapper ? depth : depth + 1;
    for (const child of node.children) emit(child, nextDepth);
  }

  emit(snap.root, 0);
  if (snap.truncated) lines.push("- … (snapshot truncated: page exceeded node limit)");
  return lines.join("\n");
}
