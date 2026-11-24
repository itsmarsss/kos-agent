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

/**
 * The chat's least beside the panel, the grid's gaps included: what is left
 * at PANEL_ROOM once the list (240) and the panel at its narrowest (160)
 * are drawn. Dragged wider than this leaves, the panel stops; it squeezed
 * the chat to 350 px at 1440, its title on two lines and its box cut.
 */
export const CHAT_ROOM = 480;

/** The element's width as laid out, kept up as it resizes; 0 until it has been. */
export function useWidthOf(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver !== "function") return;
    const watch = new ResizeObserver(([entry]) => entry && setWidth(entry.contentRect.width));
    watch.observe(el);
    return () => watch.disconnect();
  }, [ref]);
  return width;
}

/** Whether the element is wider than the given width, kept up as it resizes; so until it has been laid out. */
export function useRoomFor(ref: RefObject<HTMLElement | null>, width: number): boolean {
  const room = useWidthOf(ref);
  return room === 0 || room > width;
}

/**
 * How wide the panel is drawn: as wide as the owner made it, while the chat
 * keeps CHAT_ROOM beside it and the list; never under the panel's least.
 * `room` is the page's width (0 before it is laid out: as wanted).
 */
export function panelWidthFor(wanted: number, room: number, list: number, least: number): number {
  if (room <= 0) return wanted;
  return Math.max(least, Math.min(wanted, Math.floor(room - list - CHAT_ROOM)));
}

/**
 * The panel's own element's state: slid shut it is inert, out of the tab
 * order and the reader's view (aria-hidden alone left Tab landing on its
 * buttons in a column no wider than its border); a drawer it is a modal.
 */
export function panelFrame(hidden: boolean, modal: boolean): { inert?: boolean; role?: "dialog"; "aria-modal"?: boolean } {
  return { ...(hidden ? { inert: true } : {}), ...(modal ? { role: "dialog", "aria-modal": true } : {}) };
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
 * Escape a dialog over it already took, or one pressed while any sheet is
 * over it, is not the drawer's.
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
      // Only while it is the sheet on top: a sheet over it is drawn after it (at the body), and one
      // that leaves the keys where they were (Quick Look) is shut first, not the drawer from under it.
      const modals = document.querySelectorAll('[aria-modal="true"]');
      if (modals[modals.length - 1] !== panel.current) return;
      e.preventDefault();
      setOpen(false);
    };
    window.addEventListener("keydown", shut);
    return () => window.removeEventListener("keydown", shut);
  }, [open, panel]);
  return { open, toggle: () => setOpen((v) => !v), close: () => setOpen(false) };
}
