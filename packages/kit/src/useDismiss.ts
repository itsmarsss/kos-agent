import { useEffect, useRef, type RefObject } from "react";

/**
 * Close something that floats (a menu, a popover, a drawer, a dialog) when
 * the owner presses away from it, scrolls, resizes, or presses Escape.
 *
 * One hook rather than the five copies that had grown, each a little
 * different: the menus, the anchored popovers, the select, the drawer and the
 * dialog.
 *
 * - A press away is bound on pointerdown rather than click: a click fires
 *   after the press, by which time the thing under the pointer may have
 *   moved, and a menu that closes on the way back up feels late. A press in
 *   any of `inside`, or in a window anchored there (drawn at the body, marked
 *   .kos-pop), is not away.
 * - Scrolling counts as leaving, except a scroll inside it: a menu anchored to
 *   a row stays where it was put while the row travels out from under it,
 *   which looks like the menu has come loose from what it belongs to.
 * - Escape on a menu is taken first and stopped, so one Escape closes the
 *   menu without also closing the dialog the menu is inside; a dialog hears
 *   Escape last, after any menu in it.
 */
export interface DismissOptions {
  /** What counts as inside: the menu, and the button that opened it. */
  inside?: RefObject<Element | null>[];
  /** A press elsewhere closes it. Off for a drawer or dialog, whose backdrop does. */
  away?: boolean;
  /** Scrolling or resizing closes it. Off for what holds its place, or measures itself again. */
  scroll?: boolean;
  resize?: boolean;
  /** Who hears Escape: a menu first, a dialog last; false for one that handles its own keys. */
  escape?: "menu" | "dialog" | false;
}

export function useDismiss(open: boolean, onClose: () => void, { inside = [], away = true, scroll = true, resize = true, escape = "menu" }: DismissOptions = {}): void {
  // The latest of each, without re-binding the listeners on every render.
  const close = useRef(onClose);
  close.current = onClose;
  const within = useRef(inside);
  within.current = inside;

  useEffect(() => {
    if (!open) return;
    const isInside = (target: EventTarget | null): boolean =>
      target instanceof Node && within.current.some((r) => r.current?.contains(target));
    const pressed = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Element && target.closest(".kos-pop")) return;
      if (!isInside(target)) close.current();
    };
    const key = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (escape === "menu") event.stopPropagation();
      close.current();
    };
    // Capture, because the scroll may happen in a panel rather than the page
    // and scroll events from an element do not bubble to window.
    const scrolled = (event: Event): void => {
      if (!isInside(event.target)) close.current();
    };
    const resized = (): void => close.current();

    if (away) document.addEventListener("pointerdown", pressed, true);
    if (escape === "menu") document.addEventListener("keydown", key, true);
    if (escape === "dialog") window.addEventListener("keydown", key);
    if (scroll) window.addEventListener("scroll", scrolled, true);
    if (resize) window.addEventListener("resize", resized);
    return () => {
      document.removeEventListener("pointerdown", pressed, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", resized);
    };
  }, [open, away, scroll, resize, escape]);
}
