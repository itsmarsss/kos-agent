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
 * at the height it had, until it has been quiet for QUIET_MS. The bridge
 * debounces, so a page that is only animating reports once it rests; a
 * burst is a loop. A change the owner is making (typing in the frame) is
 * never counted towards one, so a run of Enters keeps the frame growing.
 * The bridge sends a height again while the frame is not that height, so
 * one set aside here is taken once the page has settled.
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
/** A frozen page heard nothing from for this long is taken again. */
const QUIET_MS = 2000;

export interface HeightGate {
  /** The frame's new height for a reported one, or undefined to leave it as it is; `owner` when the owner's hand is in the frame. */
  accept(reported: unknown, owner?: boolean): number | undefined;
}

export function heightGate(now: () => number = () => performance.now()): HeightGate {
  let current: number | undefined;
  let previous: number | undefined;
  const changes: number[] = [];
  let frozen = false;
  let changedAt = -Infinity;
  let heardAt = -Infinity;
  return {
    accept(reported, owner = false) {
      if (typeof reported !== "number" || !Number.isFinite(reported) || reported <= 0) return undefined;
      const t = now();
      const quiet = t - heardAt >= QUIET_MS;
      heardAt = t;
      if (frozen && !quiet) return undefined;
      if (frozen) {
        frozen = false;
        changes.length = 0;
      }
      const next = Math.round(Math.min(FRAME_HEIGHT_MAX, Math.max(FRAME_HEIGHT_MIN, reported)));
      if (current !== undefined && Math.abs(next - current) < JITTER) return undefined;
      while (changes.length && t - changes[0]! > WINDOW_MS) changes.shift();
      // Back to the height before last, at once: the page flips between two, so it keeps the one it has.
      if (!owner && previous !== undefined && Math.abs(next - previous) < JITTER && t - changedAt < FLIP_MS) return undefined;
      if (!owner && changes.length >= BURST) {
        frozen = true;
        return undefined;
      }
      if (!owner) changes.push(t);
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
 * Whether the owner's hand is in this frame: the dashboard's focus is on it
 * (a press or a key inside a frame focuses it, as the browser reports to the
 * page holding it) and the browser counts a gesture as active now. A page
 * cannot fake either; a press elsewhere on the dashboard moves the focus off.
 */
export const ownerIn = (frame: Element): boolean => document.activeElement === frame && navigator.userActivation?.isActive === true;

/** How soon after the owner's press or key in the frame a jump on its page may scroll the dashboard. */
export const REVEAL_MS = 500;
/**
 * How long after the dashboard itself sent Done a doc's save is still the
 * owner's: the doc waits out the gap between saves (2.1 s) before it sends
 * the one Done asked for, so a second would refuse the save Done made.
 */
export const DONE_MS = 2500;

/** What the dashboard last told a doc's editing to do, and when (performance.now()). */
export interface EditTold {
  action: "edit" | "done" | "discard" | "undo" | "redo";
  at: number;
  /** The owner pressed or typed in the document since it loaded or last saved: a Done finishes only that. */
  touched?: boolean;
}

/**
 * Whether a jump on the page may scroll the dashboard: the owner's hand is
 * in the frame, and they pressed or typed in it a moment ago, as the frame's
 * own capture of trusted events says over a channel the page never holds.
 */
export const revealAllowed = (frame: Element, gestureAt: number, now: number = performance.now()): boolean => ownerIn(frame) && now - gestureAt >= 0 && now - gestureAt <= REVEAL_MS;

/**
 * Whether a page's kos.save is the owner's: their hand is in the frame, or
 * the dashboard's own Done (pressed, or sent to finish before the frame goes)
 * asked for it a moment ago, after the owner's own presses or keys in the
 * document. A page only looked at saves nothing as it goes. After Discard,
 * Undo or Edit from the dashboard, nothing but the owner's hand in the frame
 * saves. The caller spends the Done on the save it lets through.
 */
export const saveAllowed = (frame: Element, told: EditTold | undefined, now: number = performance.now()): boolean =>
  ownerIn(frame) || (told?.action === "done" && told.touched === true && now - told.at >= 0 && now - told.at <= DONE_MS);

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
