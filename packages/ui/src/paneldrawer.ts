import { useFocusTrap } from "@kos/kit";
import { useEffect, useMemo, useState, type RefObject } from "react";

/**
 * The chats page's third column, the project's or the blob's panel, as a
 * drawer over the chat where the page has no room for it.
 *
 * The width is the stylesheet's too: its container query on the page
 * (chats-room) folds the column at the same width.
 */
export const PANEL_ROOM = 880;

/** Whether the element is wider than the given width, kept up as it resizes. */
export function useRoomFor(ref: RefObject<HTMLElement | null>, width: number): boolean {
  const [fits, setFits] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver !== "function") return;
    const watch = new ResizeObserver(([entry]) => entry && setFits(entry.contentRect.width > width));
    watch.observe(el);
    return () => watch.disconnect();
  }, [ref, width]);
  return fits;
}

export interface PanelDrawer {
  open: boolean;
  toggle: () => void;
  close: () => void;
}

/**
 * The drawer's state, while the room is short: opened and shut by the
 * panel's toggle, shut by its backdrop or Escape, never remembered, and shut
 * once there is room again. Open, it is a modal (the panel draws it so): the
 * tab key stays in it, and shut, the focus goes back to the toggle. An
 * Escape a dialog over it already took, or one pressed inside another
 * dialog, is not the drawer's.
 */
export function usePanelDrawer(root: RefObject<HTMLElement | null>, fits: boolean): PanelDrawer {
  const [open, setOpen] = useState(false);
  // The panel is the column's own element, drawn by whoever shows it; it is found when asked for.
  const panel = useMemo<RefObject<HTMLElement | null>>(
    () => ({
      get current() {
        return root.current?.querySelector<HTMLElement>(".project-panel") ?? null;
      },
    }),
    [root],
  );
  useFocusTrap(panel, open, panel);
  useEffect(() => {
    if (fits) setOpen(false);
  }, [fits]);
  useEffect(() => {
    if (!open) return;
    const shut = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const modal = e.target instanceof Element ? e.target.closest('[aria-modal="true"]') : null;
      if (modal && modal !== panel.current) return;
      e.preventDefault();
      setOpen(false);
    };
    window.addEventListener("keydown", shut);
    return () => window.removeEventListener("keydown", shut);
  }, [open, panel]);
  return { open, toggle: () => setOpen((v) => !v), close: () => setOpen(false) };
}
