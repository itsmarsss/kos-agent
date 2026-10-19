import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";

/**
 * Enter sends, Shift+Enter starts a new line.
 *
 * This is what every chat surface does, so anything else is a small daily
 * surprise. IME composition is excluded: pressing Enter to accept a candidate
 * would otherwise fire off a half-typed message.
 */
export function composerKeyDown(
  event: KeyboardEvent<HTMLTextAreaElement>,
  send: () => void,
): void {
  if (event.key !== "Enter") return;
  if (event.shiftKey) return;
  if (event.nativeEvent.isComposing) return;
  event.preventDefault();
  send();
}

/**
 * Keep a scroller pinned to the bottom while the reader is already there, and
 * leave it alone once they scroll up to read something.
 *
 * A one-shot scroll after render is not enough: transcripts grow taller after
 * first layout as code blocks, tool calls and markdown settle, so the scroll
 * lands partway up. Watching the content's size instead of guessing at timing
 * survives all of that.
 */
export function useStickToBottom<T extends HTMLElement>(
  ref: RefObject<T | null>,
  deps: unknown[],
): void {
  const stick = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const atBottom = (): boolean =>
      el.scrollHeight - el.scrollTop - el.clientHeight < 48;

    /*
     * Only the reader's own scrolling decides whether to follow. A snap to
     * the bottom fires a scroll event of its own, which read as "at the
     * bottom, keep following"; and a streamed reply mutates every few
     * milliseconds, so a wheel tick upward was undone by the next snap
     * before the next tick arrived. The owner could not scroll up while a
     * reply was being written. A snap is marked and its event ignored, and
     * a wheel or touch upward lets go at once.
     */
    let snapping = false;
    const onScroll = (): void => {
      if (snapping) {
        snapping = false;
        return;
      }
      stick.current = atBottom();
    };
    const onWheel = (e: WheelEvent): void => {
      if (e.deltaY < 0) stick.current = false;
    };
    const onTouch = (): void => {
      stick.current = false;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchmove", onTouch, { passive: true });

    const follow = (): void => {
      if (!stick.current || atBottom()) return;
      snapping = true;
      el.scrollTop = el.scrollHeight;
    };
    const observer = new ResizeObserver(follow);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);

    // A streamed turn arrives as a child that did not exist when the observer
    // was set up, and a scroller of fixed height never changes size as its
    // content grows, so neither of the above notices it. Watching the subtree
    // does: without this the reply streamed in below the fold.
    const mutations = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (node instanceof Element) observer.observe(node);
        }
      }
      follow();
    });
    mutations.observe(el, { childList: true, subtree: true, characterData: true });

    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchmove", onTouch);
      observer.disconnect();
      mutations.disconnect();
    };
    // Re-observe when the children change, so new turns are watched too.
  }, [ref, ...deps]);

  // A conversation opens at its newest message, not its oldest.
  useEffect(() => {
    stick.current = true;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ref, ...deps]);
}

/**
 * Grow a textarea with what is typed, up to a ceiling.
 *
 * A fixed three-row box means a long message is written through a slot, and a
 * one-word message reserves three rows of a thread that could have used them.
 */
export function useAutoGrow(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  maxRows = 12,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Reset first: without it the box can only ever get taller.
    el.style.height = "auto";
    const line = parseFloat(getComputedStyle(el).lineHeight || "20") || 20;
    const max = line * maxRows;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [ref, value, maxRows]);
}
