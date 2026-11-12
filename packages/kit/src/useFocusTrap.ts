import { useEffect, type RefObject } from "react";

/** What the tab key can land on. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keep the tab key inside a dialog while it is open, and give the focus back
 * to what had it (the button that opened it) when it shuts.
 *
 * Opening, the focus goes in unless something inside already took it (an
 * autofocused field). Tab past the last control comes round to the first,
 * and Shift+Tab before the first to the last. Shutting, the focus returns
 * only if it was still inside, or nowhere: a dialog shut by a press on
 * something else leaves the focus there.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const box = (): HTMLElement | null => ref.current;
    const stops = (): HTMLElement[] => [...(box()?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((el) => !el.closest("[hidden], [inert]"));
    // After the content has had its own say (autoFocus runs as it mounts).
    const enter = requestAnimationFrame(() => {
      const el = box();
      if (el && !el.contains(document.activeElement)) (stops()[0] ?? el).focus();
    });
    const keys = (e: KeyboardEvent): void => {
      const el = box();
      if (e.key !== "Tab" || !el) return;
      const all = stops();
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
    document.addEventListener("keydown", keys, true);
    return () => {
      cancelAnimationFrame(enter);
      document.removeEventListener("keydown", keys, true);
      const at = document.activeElement;
      const lost = !at || at === document.body || Boolean(box()?.contains(at)) || !at.isConnected;
      if (lost && before?.isConnected) before.focus();
    };
  }, [active]);
}
