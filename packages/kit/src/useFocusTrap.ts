import { useEffect, useRef, type RefObject } from "react";

import { openLayer } from "./layers.js";

/** What the tab key can land on. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Where the focus goes when what opened a sheet has gone: the page's own region, marked by the app. */
const HOME = "[data-focus-home]";

/**
 * What had the focus before the element that has it now. A field that
 * autofocuses as a sheet mounts takes the focus before the sheet's effect
 * runs, so "what opened it" is the element that focus came from.
 */
let cameFrom: HTMLElement | null = null;
if (typeof document !== "undefined") {
  document.addEventListener("focusin", (e) => {
    cameFrom = e.relatedTarget instanceof HTMLElement ? e.relatedTarget : null;
  }, true);
}

/** The tab stops inside `box`, in order, leaving out what is hidden or inert. */
export function tabStops(box: HTMLElement | null): HTMLElement[] {
  return [...(box?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((el) => !el.closest("[hidden], [inert]"));
}

/** Give the focus back to `to`, or to the page's region when `to` is gone. */
export function restoreFocus(to: HTMLElement | null): void {
  const target = to?.isConnected && to !== document.body ? to : document.querySelector<HTMLElement>(HOME);
  target?.focus({ preventScroll: true });
}

export interface FocusTrapOptions {
  /** Where the content begins (the body, past the head's Close); the first control there takes the focus. */
  start?: RefObject<HTMLElement | null> | undefined;
  /** Escape shuts it. Heard only by the sheet on top, and only if nothing inside took the key first. */
  onEscape?: (() => void) | undefined;
}

/**
 * Keep the tab key inside a sheet while it is open, and give the focus back
 * to what had it (the button that opened it) when it shuts.
 *
 * Opening, the focus goes in unless something inside already took it (an
 * autofocused field): to the first control in `start` when given, else the
 * first there is, else the sheet itself. Tab past the last control comes
 * round to the first, and Shift+Tab before the first to the last. Only the
 * sheet on top (`layers.ts`) does this, so a dialog over a drawer keeps the
 * keys. Shutting, the focus returns only if it was still inside, or nowhere:
 * a sheet shut by a press on something else leaves the focus there. When
 * the opener has gone (a row that re-rendered, a page left), it goes to the
 * page's region (`data-focus-home`) rather than to the top of the document.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean, start?: RefObject<HTMLElement | null> | FocusTrapOptions): void {
  const options: FocusTrapOptions = start && "current" in start ? { start } : (start ?? {});
  const escape = useRef(options.onEscape);
  escape.current = options.onEscape;
  const begin = options.start;
  useEffect(() => {
    if (!active) return;
    const layer = openLayer(() => ref.current);
    const box = (): HTMLElement | null => ref.current;
    const now = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const before = now && box()?.contains(now) ? (cameFrom && !box()?.contains(cameFrom) ? cameFrom : null) : now;
    // After the content has had its own say (autoFocus runs as it mounts).
    const enter = requestAnimationFrame(() => {
      const el = box();
      if (!el || el.contains(document.activeElement)) return;
      const first = tabStops(begin?.current ?? null)[0] ?? tabStops(el)[0];
      if (first) first.focus();
      else {
        if (!el.hasAttribute("tabindex")) el.tabIndex = -1;
        el.focus();
      }
    });
    const keys = (e: KeyboardEvent): void => {
      const el = box();
      if (!el || !layer.top()) return;
      if (e.key === "Escape") {
        if (!escape.current || e.defaultPrevented) return;
        e.preventDefault();
        escape.current();
        return;
      }
      if (e.key !== "Tab") return;
      const all = tabStops(el);
      if (all.length === 0) {
        e.preventDefault();
        return;
      }
      const first = all[0]!;
      const last = all[all.length - 1]!;
      const at = document.activeElement;
      if (e.shiftKey && (at === first || !el.contains(at))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || !el.contains(at))) {
        e.preventDefault();
        first.focus();
      }
    };
    // Tab on the way down, so the focus never visits the page behind; Escape
    // on the way back up, after a menu or a field inside has had it.
    const tab = (e: KeyboardEvent): void => {
      if (e.key === "Tab") keys(e);
    };
    const esc = (e: KeyboardEvent): void => {
      if (e.key === "Escape") keys(e);
    };
    document.addEventListener("keydown", tab, true);
    window.addEventListener("keydown", esc);
    return () => {
      cancelAnimationFrame(enter);
      layer.close();
      document.removeEventListener("keydown", tab, true);
      window.removeEventListener("keydown", esc);
      const at = document.activeElement;
      const lost = !at || at === document.body || Boolean(box()?.contains(at)) || !at.isConnected;
      if (lost) restoreFocus(before);
    };
  }, [active]);
}
