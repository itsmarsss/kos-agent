import { useEffect, type RefObject } from "react";

/**
 * Close a menu when the owner clicks away from it, or presses Escape.
 *
 * Menus stayed open until the same button was pressed again, which is not what
 * anyone expects and leaves one hanging over the page while you try to work
 * around it. Every menu should behave the same way, so this is a hook rather
 * than four copies that will drift.
 *
 * Bound on pointerdown rather than click: a click fires after the press, by
 * which time the thing under the pointer may have moved, and a menu that
 * closes on the way back up feels late.
 *
 * Scrolling counts as leaving. A menu anchored to a row stays where it was
 * put while the row travels out from under it, which looks like the menu has
 * come loose from whatever it belongs to.
 */
export function useDismiss(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
): void {
  useEffect(() => {
    if (!open) return;

    const away = (event: PointerEvent): void => {
      const el = ref.current;
      if (el && !el.contains(event.target as Node)) onClose();
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        // Stopped here so one Escape closes the menu without also closing the
        // dialog the menu happens to be inside.
        event.stopPropagation();
        onClose();
      }
    };

    // Capture, because the scroll may happen in a panel rather than the page
    // and scroll events from an element do not bubble to window.
    const scrolled = (): void => onClose();

    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", scrolled);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", scrolled);
    };
  }, [ref, open, onClose]);
}
