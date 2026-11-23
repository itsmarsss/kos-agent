/**
 * Back to a page puts you where you were on it.
 *
 * The browser restores the window's scroll on Back itself, but only into a
 * page already as tall as it was: a page that reads its data again on the way
 * back (the Inbox) is a loading line at that moment, the scroll is clamped to
 * 0, and the place is lost. Each page's last position is kept here by its
 * hash, and on Back or Forward it is put back as the page grows into it, for
 * as long as the page takes to load or until a finger, wheel or key moves it.
 */

/** How long, in ms, a page has to grow tall enough to be put back where it was. */
export const RESTORE_MS = 2000;

/** The events by which the reader moves the page themselves, ending a restore. */
const TAKEN = ["touchstart", "wheel", "keydown", "pointerdown"] as const;

export function keepScroll(win: Window = window): () => void {
  const kept = new Map<string, number>();
  let frame = 0;
  let deadline = 0;
  const stop = (): void => {
    win.cancelAnimationFrame(frame);
    frame = 0;
  };
  const onScroll = (): void => {
    // A restore's own scrolls, and the clamp as the old page goes, are not the reader's.
    if (frame === 0) kept.set(win.location.hash, win.scrollY);
  };
  const step = (y: number): void => {
    win.scrollTo(0, y);
    if (Math.abs(win.scrollY - y) < 2 || win.performance.now() > deadline) {
      frame = 0;
      return;
    }
    frame = win.requestAnimationFrame(() => step(y));
  };
  const onPop = (): void => {
    stop();
    const y = kept.get(win.location.hash);
    if (!y) return;
    deadline = win.performance.now() + RESTORE_MS;
    frame = win.requestAnimationFrame(() => step(y));
  };
  win.addEventListener("scroll", onScroll, { passive: true });
  win.addEventListener("popstate", onPop);
  for (const type of TAKEN) win.addEventListener(type, stop, { passive: true });
  return () => {
    stop();
    win.removeEventListener("scroll", onScroll);
    win.removeEventListener("popstate", onPop);
    for (const type of TAKEN) win.removeEventListener(type, stop);
  };
}
