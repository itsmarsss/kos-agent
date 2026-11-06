import { FRAME_HEIGHT_MAX } from "@kos/shared";

/**
 * What an artifact's frame takes from the heights its page reports.
 *
 * The height is the page's to say, so it is held here: kept between a floor
 * and FRAME_HEIGHT_MAX, a change under a couple of pixels is ignored (layout
 * rounding), a quick return to the height before last is ignored (a page
 * whose layout flips with its frame's height settles on the one it has), and
 * a page that keeps changing its height faster than a person could make it
 * (content sized to its own frame, which grows with every report) is frozen
 * at the height it had. The bridge debounces, so a page that is only
 * animating reports once it rests; a burst is a loop.
 */

/** Shorter than this is a frame that has not drawn yet. */
export const FRAME_HEIGHT_MIN = 80;
/** A change smaller than this is rounding, not content. */
const JITTER = 2;
/** More changes than this inside WINDOW_MS is a page chasing its own frame. */
const BURST = 12;
const WINDOW_MS = 1500;
/** A return to the height before last sooner than this is the page flipping, not the owner. */
const FLIP_MS = 400;

export interface HeightGate {
  /** The frame's new height for a reported one, or undefined to leave it as it is. */
  accept(reported: unknown): number | undefined;
}

export function heightGate(now: () => number = () => performance.now()): HeightGate {
  let current: number | undefined;
  let previous: number | undefined;
  const changes: number[] = [];
  let frozen = false;
  let changedAt = -Infinity;
  return {
    accept(reported) {
      if (frozen || typeof reported !== "number" || !Number.isFinite(reported) || reported <= 0) return undefined;
      const next = Math.round(Math.min(FRAME_HEIGHT_MAX, Math.max(FRAME_HEIGHT_MIN, reported)));
      if (current !== undefined && Math.abs(next - current) < JITTER) return undefined;
      const t = now();
      while (changes.length && t - changes[0]! > WINDOW_MS) changes.shift();
      // Back to the height before last, at once: the page flips between two, so it keeps the one it has.
      if (previous !== undefined && Math.abs(next - previous) < JITTER && t - changedAt < FLIP_MS) return undefined;
      if (changes.length >= BURST) {
        frozen = true;
        return undefined;
      }
      changes.push(t);
      changedAt = t;
      previous = current;
      current = next;
      return next;
    },
  };
}

/** Where on its page a jump lands, as the bridge reports it: page pixels from the page's top. */
export interface Reveal {
  top?: unknown;
  bottom?: unknown;
  block?: unknown;
}

/** The nearest ancestor that scrolls, or undefined for the window. */
function scrollerOf(el: Element): HTMLElement | undefined {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if ((o === "auto" || o === "scroll" || o === "overlay") && p.scrollHeight > p.clientHeight) return p;
  }
  return undefined;
}

const clamp = (v: unknown, lo: number, hi: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);

/**
 * Scroll the dashboard to a place on a frame's page. A frame as tall as its
 * page has no scroll of its own, so a jump within it (a #id link, the
 * contents of a doc) moves whatever holds the frame. The place is the page's
 * to say, so it is kept within the frame.
 */
export function revealInDashboard(frame: Element, at: Reveal, gap = 16): void {
  const box = frame.getBoundingClientRect();
  const holder = scrollerOf(frame);
  const view = holder ? holder.getBoundingClientRect() : { top: 0, height: window.innerHeight };
  const scrolled = holder ? holder.scrollTop : window.scrollY;
  const top = clamp(at.top, 0, box.height);
  const bottom = clamp(at.bottom, top, box.height);
  const base = scrolled + box.top - view.top;
  const y =
    at.block === "center" ? base + (top + bottom) / 2 - view.height / 2 : at.block === "end" ? base + bottom - view.height + gap : base + top - gap;
  const behavior: ScrollBehavior = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  (holder ?? window).scrollTo({ top: Math.max(0, Math.round(y)), behavior });
}
