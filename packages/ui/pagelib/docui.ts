/**
 * The doc editor's floating pieces: its icons and one menu that serves the
 * "/" menu, a block's menu, the format bar's lists and a code block's
 * language. They are drawn in the frame's body, outside the article, so
 * nothing of them is ever saved; each is the kit's menu (design.md): panel,
 * line-strong border, radius 10 with 3 px padding, rows of radius 7.
 */

import { el } from "./runtime.js";

const SVG = "http://www.w3.org/2000/svg";

/** The icons the editor draws, on the kit's 24-unit grid with its 1.7 stroke. */
export const ICONS = {
  grip: "M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01",
  plus: "M12 5v14M5 12h14",
  text: "M6 6h12M12 6v13",
  h1: "M4 6v12M12 6v12M4 12h8M17 10l2-1.5V18",
  h2: "M4 6v12M12 6v12M4 12h8M16 10.5a2 2 0 1 1 3.5 1.3L16 18h4",
  h3: "M4 6v12M12 6v12M4 12h8M16 9h4l-2.5 3a2.5 2.5 0 1 1-1.8 4.3",
  ul: "M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01",
  ol: "M10 6h10M10 12h10M10 18h10M4 5l1.5-1v5M3.8 14.5a1.4 1.4 0 1 1 2.2 1.6L4 19h2.4",
  todo: "M4 5h6v6H4zM5.5 8l1.3 1.3L9 7M14 8h6M4 15h6v6H4zM14 18h6",
  toggle: "M8 7l5 5-5 5M15 17h5",
  quote: "M5 5v14M10 8h9M10 12h9M10 16h6",
  callout: "M4 5h16v12H8l-4 3zM12 9v2M12 14h.01",
  code: "M9 8l-4 4 4 4M15 8l4 4-4 4",
  divider: "M4 12h16",
  table: "M4 5h16v14H4zM4 10h16M10 5v14",
  image: "M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9h.01",
  mention: "M16 12a4 4 0 1 1-4-4 4 4 0 0 1 4 4v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1",
  duplicate: "M9 9h11v11H9zM5 15V6a2 2 0 0 1 2-2h9",
  up: "M12 19V5M6 11l6-6 6 6",
  down: "M12 5v14M6 13l6 6 6-6",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  trash: "M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  turn: "M4 8h13l-3-3M20 16H7l3 3",
  colour: "M12 4a8 8 0 1 0 0 16c1.1 0 1.6-.9 1.2-1.8-.5-1 .2-2.2 1.4-2.2H17a3 3 0 0 0 3-3c0-5-3.6-9-8-9zM8 11h.01M11 8h.01M15 9h.01",
  back: "M15 6l-6 6 6 6",
  next: "M9 6l6 6-6 6",
  check: "M5 12l5 5 9-10",
  rowAbove: "M4 12h16v8H4zM12 3v6M9 6h6",
  rowBelow: "M4 4h16v8H4zM12 15v6M9 18h6",
  colLeft: "M12 4h8v16h-8zM6 9v6M3 12h6",
  colRight: "M4 4h8v16H4zM18 9v6M15 12h6",
  rowRemove: "M4 8h16v8H4zM9 12h6",
  colRemove: "M8 4h8v16H8zM10.5 12h3",
} as const;
export type IconName = keyof typeof ICONS;

export function icon(name: IconName, size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  for (const [k, v] of Object.entries({ width: String(size), height: String(size), viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", ICONS[name]);
  // The grip's dots and the "i" of a callout are points: a round cap two strokes wide draws them.
  if (name === "grip") path.setAttribute("stroke-width", "3");
  svg.append(path);
  return svg;
}

/**
 * The part of the frame the owner can see: a doc's frame is as tall as the
 * doc and the dashboard scrolls it, so the frame's own window is no guide to
 * where a menu has room. The dashboard says where its view is (doc.ts).
 */
const view = { top: 0, height: Infinity };
export function setView(top: number, height: number): void {
  view.top = top;
  view.height = height;
}
/** The part of the frame in view, top and bottom, in the frame's coordinates. */
export const seenPart = (): { top: number; bottom: number } => ({ top: Math.max(0, view.top), bottom: Math.min(innerHeight, view.top + view.height) });

export interface MenuItem {
  id: string;
  label: string;
  /** A second line, quieter: what the block is for. */
  note?: string;
  /** A key or markdown that does the same, shown at the row's end. */
  hint?: string;
  icon?: IconName;
  /** Drawn first in the row in place of an icon: a swatch of colour. */
  swatch?: string;
  checked?: boolean;
  danger?: boolean;
  /** Opens a second menu beside this one. */
  sub?: () => MenuItem[];
  /** Above this row, a quiet heading for a group. */
  group?: string;
}

let menus = 0;

export interface MenuOptions {
  /** Where it opens: under this box, or above it when there is no room below. */
  at: DOMRect;
  label: string;
  onPick: (item: MenuItem) => void;
  onClose?: () => void;
  /** The "/" menu keeps the caret in the text: it is a listbox the article drives, not a menu that takes focus. */
  listbox?: boolean;
  /** What to say when nothing matches. */
  empty?: string;
  /** The listbox's owner, which keeps focus while it is open (the article, for the "/" menu): told which option is picked. */
  owner?: HTMLElement;
  className?: string;
}

/**
 * A menu floating over the doc. As a menu it takes focus, moves through its
 * rows with the arrows and Home and End, opens a row's submenu with the
 * right arrow or Enter, and goes back with the left arrow or Escape; as the
 * "/" menu's listbox it leaves focus in the text and is driven by key().
 */
export class Menu {
  readonly root: HTMLElement;
  private items: MenuItem[] = [];
  private pick = 0;
  private child: Menu | undefined;
  private opts: MenuOptions | undefined;

  constructor(private readonly parent?: Menu) {
    this.root = el("div", { class: "doc-menu", hidden: true, id: `doc-menu-${++menus}` });
    this.root.addEventListener("mousedown", (e) => e.preventDefault());
    this.root.addEventListener("keydown", (e) => {
      if (!this.opts?.listbox && this.key(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
    document.body.append(this.root);
  }

  get open(): boolean {
    return !this.root.hidden;
  }

  show(items: MenuItem[], opts: MenuOptions): void {
    this.opts = opts;
    this.items = items;
    this.pick = Math.max(0, items.findIndex((i) => i.checked));
    if (this.pick >= items.length) this.pick = 0;
    this.root.className = `doc-menu${opts.className ? ` ${opts.className}` : ""}`;
    this.root.setAttribute("role", opts.listbox ? "listbox" : "menu");
    this.root.setAttribute("aria-label", opts.label);
    this.draw();
    this.root.hidden = false;
    this.root.scrollTop = 0;
    opts.owner?.setAttribute("aria-controls", this.root.id);
    opts.owner?.setAttribute("aria-expanded", "true");
    this.place(opts.at);
    this.mark();
    if (!opts.listbox) this.focusPick();
  }

  /** New rows for the same menu, as the words after "/" change. */
  update(items: MenuItem[]): void {
    this.items = items;
    this.pick = 0;
    this.draw();
    if (this.opts) this.place(this.opts.at);
    this.mark();
  }

  close(): void {
    if (!this.open) return;
    this.child?.close();
    this.root.hidden = true;
    for (const name of ["aria-controls", "aria-expanded", "aria-activedescendant"]) this.opts?.owner?.removeAttribute(name);
    const done = this.opts?.onClose;
    this.opts = undefined;
    done?.();
  }

  remove(): void {
    this.child?.remove();
    this.root.remove();
  }

  private place(at: DOMRect): void {
    const w = this.root.offsetWidth;
    const h = this.root.offsetHeight;
    const below = at.bottom + 6;
    const seen = Math.min(innerHeight, view.top + view.height);
    const top = seen - below < h && at.top - h - 6 > view.top ? at.top - h - 6 : below;
    this.root.style.left = `${Math.round(Math.max(8, Math.min(at.left, innerWidth - w - 8)) + scrollX)}px`;
    this.root.style.top = `${Math.round(Math.max(8, top) + scrollY)}px`;
  }

  private draw(): void {
    const listbox = this.opts?.listbox;
    const rows: HTMLElement[] = [];
    this.items.forEach((item, i) => {
      if (item.group) rows.push(el("p", { class: "doc-menu-group", role: "presentation" }, item.group));
      const b = el(
        "button",
        {
          type: "button",
          role: listbox ? "option" : item.checked !== undefined && !item.sub ? "menuitemradio" : "menuitem",
          "aria-selected": listbox ? String(i === this.pick) : undefined,
          "aria-checked": !listbox && item.checked !== undefined && !item.sub ? String(item.checked) : undefined,
          "aria-haspopup": item.sub ? "menu" : undefined,
          tabindex: "-1",
          id: `${this.root.id}-${i}`,
          class: [i === this.pick ? "on" : "", item.danger ? "danger" : ""].filter(Boolean).join(" ") || undefined,
        },
        item.swatch ? el("span", { class: "doc-menu-swatch", style: `--swatch: ${item.swatch}` }) : item.icon ? el("span", { class: "doc-menu-icon" }, icon(item.icon)) : null,
        el("span", { class: "doc-menu-words" }, el("span", {}, item.label), item.note ? el("small", {}, item.note) : null),
        item.hint ? el("kbd", {}, item.hint) : null,
        item.sub ? el("span", { class: "doc-menu-more" }, icon("next", 14)) : item.checked ? el("span", { class: "doc-menu-more" }, icon("check", 14)) : null,
      );
      b.addEventListener("mousemove", () => {
        if (this.pick === i) return;
        this.pick = i;
        this.mark();
        if (!listbox) b.focus({ preventScroll: true });
      });
      b.addEventListener("click", () => this.choose(i));
      rows.push(b);
    });
    if (!this.items.length) rows.push(el("p", { class: "doc-menu-none" }, this.opts?.empty ?? "Nothing here"));
    this.root.replaceChildren(...rows);
  }

  private buttons(): HTMLButtonElement[] {
    return [...this.root.querySelectorAll<HTMLButtonElement>(":scope > button")];
  }

  private mark(): void {
    this.buttons().forEach((b, i) => {
      b.classList.toggle("on", i === this.pick);
      if (this.opts?.listbox) b.setAttribute("aria-selected", String(i === this.pick));
    });
    // The menu scrolls itself to the row, never the dashboard around the frame.
    const row = this.buttons()[this.pick];
    if (this.opts?.owner) {
      if (row) this.opts.owner.setAttribute("aria-activedescendant", row.id);
      else this.opts.owner.removeAttribute("aria-activedescendant");
    }
    if (row) {
      if (row.offsetTop < this.root.scrollTop) this.root.scrollTop = row.offsetTop - 3;
      else if (row.offsetTop + row.offsetHeight > this.root.scrollTop + this.root.clientHeight) this.root.scrollTop = row.offsetTop + row.offsetHeight - this.root.clientHeight + 3;
    }
  }

  private focusPick(): void {
    this.buttons()[this.pick]?.focus({ preventScroll: true });
  }

  private choose(i: number): void {
    const item = this.items[i];
    if (!item || !this.opts) return;
    if (item.sub) {
      this.child ??= new Menu(this);
      const at = this.buttons()[i]!.getBoundingClientRect();
      const onPick = this.opts.onPick;
      this.child.show(item.sub(), { at: new DOMRect(at.right - 4, at.top - 8, 0, 0), label: item.label, onPick: (sub) => (this.close(), onPick(sub)), onClose: () => this.focusPick() });
      return;
    }
    const pick = this.opts.onPick;
    this.close();
    pick(item);
  }

  /** A key for the menu; true when it was the menu's. */
  key(e: KeyboardEvent): boolean {
    if (!this.open) return false;
    if (this.child?.open) return this.child.key(e);
    const n = this.items.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (n) this.pick = (this.pick + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      this.mark();
      if (!this.opts?.listbox) this.focusPick();
      return true;
    }
    if ((e.key === "Home" || e.key === "End") && !this.opts?.listbox) {
      this.pick = e.key === "Home" ? 0 : n - 1;
      this.mark();
      this.focusPick();
      return true;
    }
    if (e.key === "Enter" || (e.key === "Tab" && this.opts?.listbox) || (e.key === "ArrowRight" && this.items[this.pick]?.sub)) {
      if (!n) return e.key === "Enter" ? (this.close(), false) : false;
      this.choose(this.pick);
      return true;
    }
    if (e.key === "Escape" || (e.key === "ArrowLeft" && this.parent)) {
      this.close();
      return true;
    }
    if (e.key === "Tab") {
      this.close();
      return false;
    }
    return false;
  }
}
