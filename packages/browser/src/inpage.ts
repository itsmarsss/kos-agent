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
