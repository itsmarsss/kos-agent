import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/** Where an element sits in the page's layout: its offsets up the chain, which neither a scroll nor a transform changes. */
function layoutPlace(el: HTMLElement): string {
  let top = 0;
  let left = 0;
  for (let at: HTMLElement | null = el; at; at = at.offsetParent as HTMLElement | null) {
    top += at.offsetTop;
    left += at.offsetLeft;
  }
  return `${top},${left}`;
}

interface Spot {
  top: number;
  left: number;
}

const spotOf = (el: HTMLElement): Spot => {
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left };
};

const same = (a: Spot, b: Spot): boolean => a.top === b.top && a.left === b.left;

/** Where the pointer last moved by itself, and when: one listener for every card. */
const pointer = { x: Number.NaN, y: Number.NaN, at: 0 };
let following = false;
function followPointer(): void {
  if (following || typeof window === "undefined") return;
  following = true;
  window.addEventListener(
    "pointermove",
    (e) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      pointer.at = Date.now();
    },
    { capture: true, passive: true },
  );
}

/** How long a pointer may rest and still be the one that moved onto what it is over. */
const RESTING_MS = 50;

/**
 * Whether a press on `ref` now was meant for what it shows: in the last `ms`
 * the element did not arrive, say something else (`key`), move in the
 * layout, or move on screen under the pointer. A list that shifts (a card
 * arriving or going, a chat scrolling to its end) then cannot hand a click
 * aimed at one control to the one that slid under it. Only a move within
 * the window counts: a scroll and then, a moment later, a click is a press
 * like any other.
 */
export function useSteadyPress(ref: RefObject<HTMLElement | null>, ms: number, key: unknown): () => boolean {
  /** When it last arrived, changed or moved. */
  const since = useRef(0);
  const place = useRef<string | undefined>(undefined);
  // Arrived, or saying something else.
  useEffect(() => {
    since.current = Date.now();
  }, [key]);
  // Moved in the layout since the last render.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const now = layoutPlace(el);
    if (place.current !== undefined && place.current !== now) since.current = Date.now();
    place.current = now;
  });
  /*
   * Moved on screen under the pointer: while the pointer is over it, where it
   * is on screen is watched each frame and on every scroll, so a move is
   * stamped when it happens, and a press finds it where it was last seen
   * unless it moved that very frame.
   */
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    followPointer();
    let seen: Spot | undefined;
    let over = false;
    let frame = 0;
    const look = (): void => {
      const now = spotOf(el);
      if (over && seen && !same(seen, now)) since.current = Date.now();
      seen = now;
    };
    const watch = (): void => {
      look();
      frame = over && typeof requestAnimationFrame === "function" ? requestAnimationFrame(watch) : 0;
    };
    const enter = (e: PointerEvent): void => {
      if (over) return;
      over = true;
      // Over it with the pointer at rest where it last moved to: the element came to the pointer, which is a move.
      if (e.clientX === pointer.x && e.clientY === pointer.y && Date.now() - pointer.at > RESTING_MS) since.current = Date.now();
      seen = spotOf(el);
      watch();
    };
    const leave = (): void => {
      over = false;
      if (frame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
      frame = 0;
    };
    const press = (): void => {
      if (!over) {
        // Touch: no pointer rested on it, so nothing moved under one.
        seen = spotOf(el);
        return;
      }
      look();
    };
    el.addEventListener("pointerenter", enter, { passive: true });
    el.addEventListener("pointermove", enter, { passive: true });
    el.addEventListener("pointerleave", leave, { passive: true });
    el.addEventListener("pointerdown", press, { capture: true, passive: true });
    window.addEventListener("scroll", look, { capture: true, passive: true });
    return () => {
      leave();
      el.removeEventListener("pointerenter", enter);
      el.removeEventListener("pointermove", enter);
      el.removeEventListener("pointerleave", leave);
      el.removeEventListener("pointerdown", press, { capture: true });
      window.removeEventListener("scroll", look, { capture: true });
    };
  }, [ref]);
  return () => Date.now() - since.current >= ms;
}
