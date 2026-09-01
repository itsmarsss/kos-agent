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

    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [ref, open, onClose]);
}
