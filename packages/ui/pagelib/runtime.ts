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
  save?: (edit: ArtifactEdit) => Promise<unknown>;
  present?: (on?: boolean) => void;
}

export const kos = (): KosBridge | undefined => (window as unknown as { kos?: KosBridge }).kos;

/** Whether the owner may edit the artifact here: the bridge can save, and the frame is not showing an older version. */
export const editable = (): boolean => typeof kos()?.save === "function" && !document.documentElement.hasAttribute("data-locked");

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
