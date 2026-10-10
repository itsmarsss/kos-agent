/**
 * A window that floats over the page: where it sits, how big it is, and
 * how it moves when an edge is pulled. Shared by the quick-question window
 * and the browser view, so both remember their place the same way and
 * neither can be dragged off screen.
 */

/** Where the window sits and how big it is, in viewport pixels. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export const EDGES: readonly Edge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

/** How close to the viewport's edge a window may go. */
export const EDGE = 8;

export interface MinSize {
  width: number;
  height: number;
}

/** The box, kept at least the minimum size and inside the viewport. */
export function clampBox(b: Box, min: MinSize): Box {
  const width = Math.max(min.width, Math.min(b.width, window.innerWidth - EDGE * 2));
  const height = Math.max(min.height, Math.min(b.height, window.innerHeight - EDGE * 2));
  return {
    width,
    height,
    left: Math.max(EDGE, Math.min(b.left, window.innerWidth - width - EDGE)),
    top: Math.max(EDGE, Math.min(b.top, window.innerHeight - height - EDGE)),
  };
}

/** The box after one of its edges moved by (dx, dy). The opposite edge stays put. */
export function resizedBox(from: Box, edge: Edge, dx: number, dy: number, min: MinSize): Box {
  let { left, top, width, height } = from;
  const right = from.left + from.width;
  const bottom = from.top + from.height;
  if (edge.includes("e")) width = Math.max(min.width, Math.min(from.width + dx, window.innerWidth - EDGE - from.left));
  if (edge.includes("s")) height = Math.max(min.height, Math.min(from.height + dy, window.innerHeight - EDGE - from.top));
  if (edge.includes("w")) {
    left = Math.max(EDGE, Math.min(from.left + dx, right - min.width));
    width = right - left;
  }
  if (edge.includes("n")) {
    top = Math.max(EDGE, Math.min(from.top + dy, bottom - min.height));
    height = bottom - top;
  }
  return { left, top, width, height };
}

/** The remembered box under `key`, or the first-time one `fallback` gives. */
export function readBox(key: string, min: MinSize, fallback: () => Box): Box {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return clampBox(JSON.parse(raw) as Box, min);
  } catch {
    /* private window, or a stale shape */
  }
  return clampBox(fallback(), min);
}

export function saveBox(key: string, b: Box): void {
  try {
    localStorage.setItem(key, JSON.stringify(b));
  } catch {
    /* private window */
  }
}

/** A box of the given size tucked into the bottom right corner. */
export function cornerBox(width: number, height: number, inset = 18): Box {
  const w = Math.min(width, window.innerWidth - EDGE * 2);
  const h = Math.min(height, window.innerHeight - EDGE * 2);
  return { left: window.innerWidth - w - inset, top: window.innerHeight - h - inset, width: w, height: h };
}
