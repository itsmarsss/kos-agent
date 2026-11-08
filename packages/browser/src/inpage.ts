/**
 * What runs inside the page.
 *
 * Each function here is sent to the tab as source text and run there, on an
 * element (`this`) or on the document, so each must stand alone: no imports,
 * no helpers from outside, nothing but the DOM. Kept apart from the engine so
 * that rule is easy to keep.
 */

/** The element text goes into: this one, the control a label is for, or the first field inside. */
export function editableOf(this: Element): Element | null {
  const el = this as HTMLElement;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable) return el;
  if (el instanceof HTMLLabelElement && el.control) return el.control;
  return el.querySelector("input:not([type=hidden]), textarea, [contenteditable=''], [contenteditable=true]");
}

/** Everything in the field selected, so what is typed next replaces it. */
export function selectAll(this: Element): void {
  const el = this as HTMLElement;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    try {
      el.select();
    } catch {
      /* an input type with no selection, such as a date */
    }
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(el);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** The caret at the end of the field, so what is typed next is added to it. */
export function caretToEnd(this: Element): void {
  const el = this as HTMLElement;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    try {
      el.setSelectionRange(el.value.length, el.value.length);
    } catch {
      /* an input type with no caret */
    }
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** A form field's value; null for anything else. */
export function valueOf(this: Element): string | null {
  return this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement || this instanceof HTMLSelectElement ? this.value : null;
}

/**
 * A field's value set the way a framework notices: through the native
 * setter, then the events a person's typing would raise. For the inputs
 * typed text does not reach, such as a date.
 */
export function setValue(this: Element, value: string): string {
  const el = this as HTMLInputElement | HTMLTextAreaElement;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return el.value;
}

/** Options of a <select> picked by value or by label; what was picked, or what there is. */
export function selectOptions(this: Element, wanted: string[]): { picked?: string[]; error?: "not-select" | "no-option"; options?: string[] } {
  if (!(this instanceof HTMLSelectElement)) return { error: "not-select" };
  const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();
  const want = wanted.map(norm);
  const picked: string[] = [];
  for (const option of Array.from(this.options)) {
    const hit = want.includes(norm(option.value)) || want.includes(norm(option.label)) || want.includes(norm(option.text));
    if (hit && (this.multiple || picked.length === 0)) {
      option.selected = true;
      picked.push(option.label || option.text);
    } else if (this.multiple) {
      option.selected = false;
    }
  }
  if (picked.length === 0) return { error: "no-option", options: Array.from(this.options).slice(0, 40).map((o) => o.label || o.text) };
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return { picked };
}

/** Whether a checkbox, radio or switch is on; null when it is none of those. */
export function checkedOf(this: Element): boolean | null {
  if (this instanceof HTMLInputElement && (this.type === "checkbox" || this.type === "radio")) return this.checked;
  const aria = this.getAttribute("aria-checked") ?? this.getAttribute("aria-pressed");
  return aria === null ? null : aria === "true";
}

/** The label a control is drawn by, for one that is hidden behind it. */
export function labelOf(this: Element): Element | null {
  const labels = (this as HTMLInputElement).labels;
  return labels?.[0] ?? this.closest("label");
}

/** Whether a click on `other` reaches this element: it is this, inside it, or holds it, through shadow roots too. */
export function reaches(this: Element, other: Node): boolean {
  const up = (n: Node | null): Node | null => n?.parentNode ?? (n instanceof ShadowRoot ? n.host : null);
  const within = (start: Node, target: Node): boolean => {
    for (let n: Node | null = start; n; n = up(n)) if (n === target) return true;
    return false;
  };
  return within(other, this) || within(this, other);
}

/** An element in a few words: its tag, id, a class, and the start of its text. */
export function describe(this: Element): string {
  const el = this instanceof Element ? this : (this as Node).parentElement;
  if (!el) return "something";
  const id = el.id ? `#${el.id}` : "";
  const cls = typeof el.className === "string" && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "";
  const words = ((el as HTMLElement).innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  return `<${el.tagName.toLowerCase()}${id}${cls}>${words ? ` "${words}"` : ""}`;
}

/** Brought to the middle of the view, clear of the bars a page keeps at its edges. */
export function centre(this: Element): void {
  this.scrollIntoView({ block: "center", inline: "center" });
}

/**
 * The element a text selector means: of those `base` names (anything, when
 * none), the innermost whose words hold the text, so "Submit" is the button
 * and not the form around it. Spelled as Playwright does, which is how a
 * model writes one: button:has-text('Submit'), text=Submit.
 */
export function byText(base: string, text: string): Element | null {
  const want = text.replace(/\s+/g, " ").trim().toLowerCase();
  const holds = (el: Element): boolean => ((el as HTMLElement).innerText ?? el.textContent ?? "").replace(/\s+/g, " ").toLowerCase().includes(want);
  const all = Array.from(document.querySelectorAll(base || "*")).filter(holds);
  const visible = all.filter((el) => (el as HTMLElement).offsetParent !== null || el.getClientRects().length > 0);
  const pool = visible.length ? visible : all;
  return pool.find((el) => !pool.some((other) => other !== el && el.contains(other))) ?? null;
}

/** Whether what a wait is for has come: text on the page, an element, or text gone. */
export function present(kind: "text" | "selector" | "gone", value: string): boolean {
  if (kind === "selector") return document.querySelector(value) !== null;
  const has = (document.body?.innerText ?? "").includes(value);
  return kind === "text" ? has : !has;
}

/**
 * The page as text: the elements a selector names, or the main part of the
 * page (its <main> or <article>, unless that is a sliver of it), with the
 * links in it after.
 */
export function readPage(selector: string | null): { text: string; links: { text: string; href: string }[]; matched: number } | null {
  const body = document.body;
  if (!body) return null;
  let picked: HTMLElement[];
  if (selector) {
    picked = Array.from(document.querySelectorAll<HTMLElement>(selector));
    if (picked.length === 0) return null;
  } else {
    const main = document.querySelector<HTMLElement>("main, [role=main], article");
    picked = [main && main.innerText.length > body.innerText.length * 0.3 ? main : body];
  }
  const text = picked
    .map((el) => el.innerText.replace(/\n{3,}/g, "\n\n").trim())
    .filter(Boolean)
    .join("\n\n");
  const seen = new Set<string>();
  const links: { text: string; href: string }[] = [];
  for (const el of picked) {
    for (const a of Array.from(el.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
      const href = a.href;
      const words = a.innerText.replace(/\s+/g, " ").trim().slice(0, 80);
      if (!words || seen.has(href) || href.startsWith("javascript:")) continue;
      seen.add(href);
      links.push({ text: words, href });
      if (links.length >= 40) break;
    }
  }
  return { text, links, matched: picked.length };
}

/** Where the page is and what it is called. */
export function whereAmI(): { url: string; title: string } {
  return { url: location.href, title: document.title };
}

/**
 * Until the document has not changed for `quietMs` and `graceMs` has gone
 * since this call, or `maxMs` has; true when it went still. Run in a world of
 * KOS's own, so what it keeps is out of the page's sight; the watch on the
 * document starts on the first call and serves every later one for it.
 */
export function domQuiet(quietMs: number, graceMs: number, maxMs: number): Promise<boolean> {
  const g = globalThis as unknown as { kosChanged?: { at: number } };
  let changed = g.kosChanged;
  if (!changed) {
    const kept = { at: performance.now() };
    new MutationObserver(() => {
      kept.at = performance.now();
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    changed = g.kosChanged = kept;
  }
  const last = changed;
  const start = performance.now();
  return new Promise((resolve) => {
    const check = (): void => {
      const now = performance.now();
      const wait = Math.max(quietMs - (now - last.at), graceMs - (now - start));
      if (wait <= 0) return resolve(true);
      if (now - start >= maxMs) return resolve(false);
      setTimeout(check, Math.max(1, Math.min(wait, maxMs - (now - start))));
    };
    check();
  });
}

/** A control as the page shows it, for the index. `frame` marks a frame that could not be read from here. */
export interface FoundControl {
  role: string;
  name: string;
  states: string[];
  value?: string;
  dialog?: string;
  /** Links of the same label after this one, folded into it. */
  more?: number;
  frame?: string;
  /** The frame is still loading its page: there is nothing of it to read yet. */
  loading?: true;
  /** An element whose shadow root may be closed to scripts, KOS's among them: asked of the browser, not read. */
  closed?: true;
}

/**
 * What can be acted on, in reading order: each rendered control a reader
 * would announce (its role, label, state and value, as Chrome's
 * accessibility tree says them), through open shadow roots and the frames
 * this document can reach. A frame it cannot reach is marked where it sits,
 * to be read on its own, and so is one still loading its page and an
 * element that may hold a shadow root closed to scripts, to be said as not
 * read. A control a page marks as presentation is kept when it can still be
 * focused, as a reader keeps it; what an element owns by aria-owns is read
 * as inside it. Links of one label fold into the first; at most
 * `max` controls of each dialog and of the page are kept, and `total` says
 * how many there were. The answer is the elements, in order, with what was
 * found about them as JSON under `kos`, so their nodes can be asked for in
 * one go.
 */
export function controls(scope: string | null, max: number): Element[] {
  const CONTROLS = new Set(["button", "link", "textbox", "searchbox", "combobox", "listbox", "checkbox", "radio", "switch", "slider", "spinbutton", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option", "treeitem"]);
  const VALUED = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider"]);
  const CHECKABLE = new Set(["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"]);
  /** Roles named by their own words when nothing else names them. */
  const FROM_CONTENT = new Set(["button", "link", "tab", "option", "menuitem", "menuitemcheckbox", "menuitemradio", "treeitem", "checkbox", "radio", "switch"]);
  const FRAMES_MAX = 8;
  const CLOSED_MAX = 8;
  const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

  /** Not drawn, or kept from readers: what is inside it is not on the page. */
  const away = (el: Element): boolean => {
    if (el.getAttribute("aria-hidden") === "true" || el.hasAttribute("inert")) return true;
    return !el.checkVisibility() && getComputedStyle(el).display !== "contents";
  };
  const roleOf = (el: Element): string => {
    const explicit = (el.getAttribute("role") ?? "").trim().split(/\s+/)[0]?.toLowerCase();
    // Presentation on something that can be focused is ignored, as a reader ignores it.
    if (explicit && !((explicit === "none" || explicit === "presentation") && (el.hasAttribute("tabindex") || CONTROLS.has(nativeRole(el))))) return explicit;
    return nativeRole(el);
  };
  function nativeRole(el: Element): string {
    switch (el.localName) {
      case "a":
      case "area":
        return el.hasAttribute("href") ? "link" : "";
      case "button":
        return "button";
      case "textarea":
        return "textbox";
      case "select":
        return (el as HTMLSelectElement).multiple || (el as HTMLSelectElement).size > 1 ? "listbox" : "combobox";
      case "dialog":
        return "dialog";
      case "input": {
        const input = el as HTMLInputElement;
        switch (input.type) {
          case "button":
          case "submit":
          case "reset":
          case "image":
          case "file":
            return "button";
          case "checkbox":
          case "radio":
            return input.type;
          case "range":
            return "slider";
          case "number":
            return "spinbutton";
          case "search":
            return input.hasAttribute("list") ? "combobox" : "searchbox";
          case "text":
          case "email":
          case "tel":
          case "url":
          case "password":
            return input.hasAttribute("list") ? "combobox" : "textbox";
          default:
            return "";
        }
      }
      default:
        return "";
    }
  }
  /** An element's words as a reader hears them: rendered text, pictures by their alt, fields left out. */
  const wordsOf = (root: Element): string => {
    const parts: string[] = [];
    let size = 0;
    const walk = (n: Node): void => {
      if (size > 400) return;
      if (n.nodeType === Node.TEXT_NODE) {
        const t = (n as Text).data;
        parts.push(t);
        size += t.length;
        return;
      }
      if (!(n instanceof Element)) {
        for (const c of Array.from(n.childNodes)) walk(c);
        return;
      }
      if (n !== root) {
        if (/^(input|select|textarea|script|style|template|noscript)$/.test(n.localName) || away(n) || !n.checkVisibility({ visibilityProperty: true })) return;
        const label = n.getAttribute("aria-label");
        if (label?.trim()) {
          parts.push(` ${label} `);
          return;
        }
      }
      if (n.localName === "img" || n.localName === "area") {
        parts.push(` ${n.getAttribute("alt") ?? ""} `);
        return;
      }
      if (n.localName === "svg") {
        parts.push(` ${n.querySelector("title")?.textContent ?? ""} `);
        return;
      }
      const kids = n.localName === "slot" ? (n as HTMLSlotElement).assignedNodes({ flatten: true }) : Array.from((n.shadowRoot ?? n).childNodes);
      parts.push(" ");
      for (const c of kids) walk(c);
      parts.push(" ");
    };
    walk(root);
    return squash(parts.join(""));
  };
  const byIds = (el: Element, attr: string): string => {
    const ids = el.getAttribute(attr);
    if (!ids) return "";
    const root = el.getRootNode() as Document | ShadowRoot;
    return squash(
      ids
        .split(/\s+/)
        .map((id) => {
          const t = root.getElementById(id);
          return t ? wordsOf(t) : "";
        })
        .join(" "),
    );
  };
  const nameOf = (el: Element, role: string): string => {
    const by = byIds(el, "aria-labelledby") || squash(el.getAttribute("aria-label") ?? "");
    if (by) return by;
    if (el instanceof HTMLInputElement) {
      if (el.type === "submit" || el.type === "reset" || el.type === "button") return el.value || (el.type === "submit" ? "Submit" : el.type === "reset" ? "Reset" : "");
      if (el.type === "image") return el.alt || el.value || "Submit";
    }
    if (el instanceof HTMLOptionElement) return squash(el.label || el.text);
    const labels = (el as HTMLInputElement).labels;
    if (labels?.length) {
      const t = squash(Array.from(labels, (l) => wordsOf(l)).join(" "));
      if (t) return t;
    }
    if (FROM_CONTENT.has(role)) {
      const t = wordsOf(el);
      if (t) return t;
    }
    return squash(el.getAttribute("title") || el.getAttribute("placeholder") || el.getAttribute("aria-placeholder") || "");
  };
  const valueOf = (el: Element, role: string): string | undefined => {
    if (!VALUED.has(role)) return undefined;
    if (el instanceof HTMLInputElement) return el.type === "password" ? "•".repeat(el.value.length) : el.value;
    if (el instanceof HTMLTextAreaElement) return el.value;
    if (el instanceof HTMLSelectElement) {
      const picked = el.selectedOptions[0];
      return picked ? squash(picked.label || picked.text) : "";
    }
    return el.getAttribute("aria-valuetext") ?? el.getAttribute("aria-valuenow") ?? squash(el.textContent ?? "");
  };
  let focused: Element | null = document.activeElement;
  while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
  const statesOf = (el: Element, role: string): string[] => {
    const out: string[] = [];
    if (CHECKABLE.has(role)) {
      const input = el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio") ? el : null;
      const checked = input ? (input.indeterminate ? "mixed" : String(input.checked)) : el.getAttribute("aria-checked");
      out.push(checked === "true" ? "checked" : checked === "mixed" ? "mixed" : "unchecked");
    }
    if (el.getAttribute("aria-pressed") === "true") out.push("pressed");
    const expanded = el.getAttribute("aria-expanded") ?? (el instanceof HTMLSelectElement && role === "combobox" ? "false" : null);
    if (expanded === "true") out.push("expanded");
    else if (expanded === "false") out.push("collapsed");
    if (el instanceof HTMLOptionElement ? el.selected : el.getAttribute("aria-selected") === "true") out.push("selected");
    if (el.matches(":disabled") || el.getAttribute("aria-disabled") === "true") out.push("disabled");
    if (el === focused) out.push("focused");
    if (role === "treeitem") {
      let level = Number(el.getAttribute("aria-level"));
      if (!level) {
        level = 1;
        for (let up = el.parentElement?.closest("[role=treeitem]"); up; up = up.parentElement?.closest("[role=treeitem]")) level++;
      }
      out.push(`level ${level}`);
    }
    return out;
  };

  const els: Element[] = [];
  const items: FoundControl[] = [];
  const shown = new Map<string, number>();
  const links = new Map<string, FoundControl>();
  let total = 0;
  let frames = 0;
  let closed = 0;
  /** What elements own by aria-owns, read where their owner is and not where they sit. */
  const owned = new Map<Element, Element[]>();
  const ownedBy = new Set<Element>();
  for (const owner of Array.from(document.querySelectorAll("[aria-owns]"))) {
    const kids = (owner.getAttribute("aria-owns") ?? "")
      .split(/\s+/)
      .map((id) => (id ? document.getElementById(id) : null))
      .filter((k): k is HTMLElement => k !== null && k !== owner && !k.contains(owner) && !ownedBy.has(k));
    for (const k of kids) ownedBy.add(k);
    if (kids.length) owned.set(owner, kids);
  }
  const add = (el: Element, role: string, dialog: string | undefined): void => {
    const name = nameOf(el, role);
    if (role === "link" && !name) return;
    const value = valueOf(el, role);
    const item: FoundControl = { role, name, states: statesOf(el, role), ...(value !== undefined ? { value } : {}), ...(dialog !== undefined ? { dialog } : {}) };
    const group = dialog ?? "";
    if (role === "link") {
      const same = links.get(`${group}|${name}`);
      if (same) {
        same.more = (same.more ?? 0) + 1;
        return;
      }
      links.set(`${group}|${name}`, item);
    }
    total++;
    const n = shown.get(group) ?? 0;
    if (n >= max) return;
    shown.set(group, n + 1);
    items.push(item);
    els.push(el);
  };
  const visit = (el: Element, dialog: string | undefined, owner = false): void => {
    if ((ownedBy.has(el) && !owner) || away(el)) return;
    const role = roleOf(el);
    if (role === "dialog" || role === "alertdialog") dialog = byIds(el, "aria-labelledby") || squash(el.getAttribute("aria-label") ?? "") || role;
    if (el.localName === "iframe" || el.localName === "frame") {
      let inner: Document | null = null;
      try {
        inner = (el as HTMLIFrameElement).contentDocument;
      } catch {
        inner = null;
      }
      const src = (el as HTMLIFrameElement).src || "about:blank";
      // The blank document a frame holds until its page comes is not its page.
      const loading = inner !== null && inner.URL === "about:blank" && !src.startsWith("about:");
      if (inner?.documentElement && !loading) visit(inner.documentElement, dialog);
      else if (frames++ < FRAMES_MAX) {
        items.push({ role: "", name: "", states: [], frame: src, ...(loading ? { loading: true as const } : {}), ...(dialog !== undefined ? { dialog } : {}) });
        els.push(el);
      }
      return;
    }
    if (!el.shadowRoot && el.localName.includes("-") && el.matches(":defined") && closed < CLOSED_MAX) {
      closed++;
      items.push({ role: "", name: "", states: [], closed: true });
      els.push(el);
    }
    if (CONTROLS.has(role) && el.checkVisibility({ visibilityProperty: true })) add(el, role, dialog);
    if (el instanceof HTMLSelectElement) {
      for (const option of Array.from(el.options)) if (!option.hidden) add(option, roleOf(option) || "option", dialog);
      return;
    }
    const kids = el.localName === "slot" ? (el as HTMLSlotElement).assignedElements({ flatten: true }) : Array.from((el.shadowRoot ?? el).children);
    for (const kid of kids) visit(kid, dialog);
    for (const kid of owned.get(el) ?? []) visit(kid, dialog, true);
  };
  const root = scope ? document.querySelector(scope) : document.documentElement;
  if (!root) return Object.assign([], { kos: JSON.stringify({ missing: true }) });
  visit(root, undefined);
  return Object.assign(els, { kos: JSON.stringify({ items, total }) });
}
