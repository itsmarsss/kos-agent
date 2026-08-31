import type { KeyboardEvent } from "react";

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
 * Pin a scroller to the bottom. Called after paint so the element has its
 * final height: measuring during render leaves a freshly-opened conversation
 * scrolled to the top, showing the oldest message rather than the newest.
 */
export function scrollToBottom(el: HTMLElement | null): void {
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

import { useEffect, useRef, type RefObject } from "react";

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

    const onScroll = (): void => {
      stick.current = atBottom();
    };
    el.addEventListener("scroll", onScroll, { passive: true });

    const follow = (): void => {
      if (stick.current) el.scrollTop = el.scrollHeight;
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
