/**
 * The presenter view's state, kept pure so it is tested apart from the page
 * (DeckPresenter.tsx): which slide, what a key does, and the elapsed timer.
 * The dashboard holds the place; every deck frame it drives (the current
 * slide, the next one, the audience window's) is told it.
 */

/** What the owner can do from the presenter view's keys and buttons. */
export type PresenterMove = "next" | "prev" | "first" | "last";

/** The action a key stands for in the presenter view, or none. Escape ends presenting. */
export function presenterKey(key: string, shift = false): PresenterMove | "end" | undefined {
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
    case "PageDown":
      return "next";
    case " ":
    case "Spacebar":
      return shift ? "prev" : "next";
    case "ArrowLeft":
    case "ArrowUp":
    case "PageUp":
      return "prev";
    case "Home":
      return "first";
    case "End":
      return "last";
    case "Escape":
      return "end";
    default:
      return undefined;
  }
}

/** A slide's place, kept in the deck. */
export const clampSlide = (index: number, count: number): number => Math.max(0, Math.min(Math.max(0, count - 1), Math.round(index)));

/** Where a move takes the presenter: one at a time, stopping at either end. */
export function moveSlide(index: number, count: number, move: PresenterMove): number {
  switch (move) {
    case "next":
      return clampSlide(index + 1, count);
    case "prev":
      return clampSlide(index - 1, count);
    case "first":
      return 0;
    case "last":
      return clampSlide(count - 1, count);
  }
}

/** The slide after this one, or none on the last. */
export const slideAfter = (index: number, count: number): number | undefined => (index + 1 < count ? index + 1 : undefined);

/** The elapsed timer: what it ran before, and since when it runs now (none while paused). */
export interface Clock {
  ran: number;
  since: number | undefined;
}

export const startClock = (now: number): Clock => ({ ran: 0, since: now });

export const clockElapsed = (c: Clock, now: number): number => c.ran + (c.since === undefined ? 0 : Math.max(0, now - c.since));

export const clockRunning = (c: Clock): boolean => c.since !== undefined;

export const pauseClock = (c: Clock, now: number): Clock => (c.since === undefined ? c : { ran: clockElapsed(c, now), since: undefined });

export const resumeClock = (c: Clock, now: number): Clock => (c.since === undefined ? { ...c, since: now } : c);

/** Back to nought, running on if it ran. */
export const resetClock = (c: Clock, now: number): Clock => ({ ran: 0, since: c.since === undefined ? undefined : now });

/** The timer as a clock reads: 0:00, 4:05, 1:02:03. */
export function clockWords(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
