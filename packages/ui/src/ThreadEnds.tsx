import { useEffect, useState, type ReactElement, type RefObject } from "react";

import { announce, ChevronDown } from "@kos/kit";

/**
 * The two ends of a long thread: Show earlier at the top, for what was not
 * read yet, and Jump to latest at the bottom once the reader is a screen or
 * more above the newest message. A long chat opened on its last stretch with
 * no sign of what came before, and getting back down took 25 flings.
 */

/** Show earlier: reads more, keeping what is on screen where it was. */
export function EarlierButton({ count, scroller, onShow }: { count: number; scroller: RefObject<HTMLElement | null>; onShow: () => Promise<number> }): ReactElement {
  const [busy, setBusy] = useState(false);
  const show = async (): Promise<void> => {
    const el = scroller.current;
    const fromBottom = el ? el.scrollHeight - el.scrollTop : 0;
    setBusy(true);
    try {
      const more = await onShow();
      // After the new rows are drawn: the message that was at the top stays there.
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - fromBottom;
      });
      announce(more > 0 ? `Showing ${more} earlier ${more === 1 ? "message" : "messages"}` : "Nothing earlier");
    } catch {
      announce("Could not read the earlier messages", "assertive");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="chat-earlier">
      <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void show()}>
        {busy ? "Reading…" : `Show earlier messages (${count})`}
      </button>
    </div>
  );
}

/** How far above the bottom, in screens, the reader is before Jump to latest shows. */
const AWAY_SCREENS = 1;

/** Whether the scroller is a screen or more above its bottom, kept as it scrolls and as it grows. */
export function useAwayFromLatest(scroller: RefObject<HTMLElement | null>, key: unknown): boolean {
  const [away, setAway] = useState(false);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return undefined;
    const check = (): void => setAway(el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight * AWAY_SCREENS);
    check();
    el.addEventListener("scroll", check, { passive: true });
    const sized = new ResizeObserver(check);
    sized.observe(el);
    return () => {
      el.removeEventListener("scroll", check);
      sized.disconnect();
    };
  }, [scroller, key]);
  return away;
}

/** Jump to latest: back to the newest message, at once under reduced motion, and the focus to the box to answer. */
export function JumpToLatest({ scroller, onJumped }: { scroller: RefObject<HTMLElement | null>; onJumped?: () => void }): ReactElement {
  const jump = (): void => {
    const el = scroller.current;
    if (!el) return;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    el.scrollTo({ top: el.scrollHeight, behavior: still ? "auto" : "smooth" });
    onJumped?.();
  };
  return (
    <div className="chat-jump-dock">
      <button type="button" className="btn btn--sm chat-jump" onClick={jump}>
        <ChevronDown size={12} title="" />
        Jump to latest
      </button>
    </div>
  );
}
