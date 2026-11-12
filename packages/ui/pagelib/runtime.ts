/**
 * What the three kind runtimes share. Each runs inlined in an artifact's
 * frame, in its head, before the agent's markup exists; it adds its
 * stylesheet at once (so the agent's own CSS, which comes later, wins at
 * equal specificity) and does its work once the document is parsed.
 *
 * The frame's guard refuses scripts, links, frames, forms, meta and base,
 * so a runtime makes none of them; and it never uses a link's href, since a
 * relative link in a srcdoc frame resolves against the dashboard's address
 * and would try to navigate. Jumps within the page are buttons that scroll.
 */

import type { ArtifactEdit } from "@kos/shared";

/** The part of window.kos a runtime uses; save and present are newer, so they may be missing. */
export interface KosBridge {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; truncated?: boolean }>;
  write(table: string, op: "insert" | "update" | "delete", values: Record<string, unknown>, key?: { column: string; value: unknown }): Promise<unknown>;
  /** Several writes in one transaction, all or none; newer, so it may be missing. */
  writes?: (list: { table: string; op: "insert" | "update" | "delete"; values?: Record<string, unknown>; key?: { column: string; value: unknown } }[]) => Promise<{ done: number; results: { changes: number }[] }>;
  save?: (edit: ArtifactEdit) => Promise<unknown>;
  present?: (on?: boolean) => void;
  /** A doc's @ mention: the dashboard's picker opens at this place in the frame, and answers with the artifact picked, or null. */
  mention?: (at: { x: number; y: number }) => Promise<{ id: string; title: string } | null>;
  /** Open another artifact in the dashboard, as a doc's mention does when pressed. */
  open?: (id: string) => Promise<unknown>;
}

export const kos = (): KosBridge | undefined => (window as unknown as { kos?: KosBridge }).kos;

/** Whether the owner may edit the artifact here: the bridge can save, and the frame is not showing an older version. */
export const editable = (): boolean => typeof kos()?.save === "function" && !document.documentElement.hasAttribute("data-locked");

/** Whether the frame is shown in the phone's app, under its own bar naming the artifact (artifactdoc.ts, surface). */
export const onPhone = (): boolean => document.documentElement.getAttribute("data-surface") === "phone";

const words = (text: string | null | undefined): string => (text ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The heading that only repeats the title the phone's bar already shows: the
 * page's first heading, when it is an h1 saying the artifact's title. A
 * heading of other words, or after another one, is the agent's own.
 */
export function repeatedTitle(root: ParentNode, title: string): HTMLElement | undefined {
  const first = root.querySelector<HTMLElement>("h1, h2, h3, h4, h5, h6");
  return first?.tagName === "H1" && words(title) !== "" && words(first.textContent) === words(title) ? first : undefined;
}

/** On the phone, hide the heading that repeats its bar's title, however the agent's CSS shows headings. */
export function hideRepeatedTitle(): void {
  if (onPhone()) repeatedTitle(document.body, document.documentElement.getAttribute("data-title") ?? "")?.style.setProperty("display", "none", "important");
}

/** Add the runtime's stylesheet right after its own script, so it precedes anything the agent wrote. */
export function addStyle(css: string, id: string): void {
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = css;
  const me = document.currentScript;
  if (me?.parentNode) me.parentNode.insertBefore(style, me.nextSibling);
  else document.head.prepend(style);
}

/** Run once the document is parsed. */
export function ready(fn: () => void): void {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn, { once: true });
  else fn();
}

/** An element with attributes and children, marked as the runtime's own. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.setAttribute("data-kos-gen", "");
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children) if (c !== null && c !== undefined) node.append(c);
  return node;
}

/** A message from a refused call, as the bridge words it. */
export const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Whether a click landed on something that acts on its own. */
export const interactive = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest("a,button,input,select,textarea,label,summary,[contenteditable=true],[tabindex]:not([tabindex='-1'])") !== null;

/** Whether the owner asked for less motion. */
export const reducedMotion = (): boolean => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A range of figures with an en dash ("Ch. 1–6", "2026–2027"), the one thing a line must not break inside. */
const RANGE = /\b\d{1,4}\s?–\s?\d{1,4}\b/g;

/**
 * Keep each range of figures in the text of what `selector` matches on one
 * line: wrapped in a `.nowrap` span of the runtime's own, which `mark` can
 * mark further (a doc marks it to be unwrapped, so it is never saved).
 */
export function keepRanges(root: ParentNode, selector: string, mark?: (span: HTMLElement) => void): void {
  for (const host of root.querySelectorAll(selector)) {
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
    for (const text of texts) {
      if (text.parentElement?.closest(".nowrap")) continue;
      const parts: Node[] = [];
      let at = 0;
      for (const m of text.data.matchAll(RANGE)) {
        if (m.index > at) parts.push(document.createTextNode(text.data.slice(at, m.index)));
        const span = el("span", { class: "nowrap" }, m[0]);
        mark?.(span);
        parts.push(span);
        at = m.index + m[0].length;
      }
      if (!parts.length) continue;
      if (at < text.data.length) parts.push(document.createTextNode(text.data.slice(at)));
      text.replaceWith(...parts);
    }
  }
}
