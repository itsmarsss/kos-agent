import { useEffect, useRef, type RefObject } from "react";

/**
 * Says which ends of a row that scrolls sideways have more past it, as
 * `data-more` ("start", "end" or both) on the row, so its edge fades there
 * (styles.css): on a phone the last tabs or chips sat off screen with
 * nothing to say they were there.
 *
 * The ref goes on the row itself, or on a wrapper with `selector` naming
 * the row inside it, for a kit piece that takes no ref of its own.
 */
export function useEdgeFade<T extends HTMLElement>(selector?: string): RefObject<T | null> {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = selector ? ref.current?.querySelector<HTMLElement>(selector) : ref.current;
    if (!el) return;
    const mark = (): void => {
      const ends = [el.scrollLeft > 1 ? "start" : "", el.scrollLeft + el.clientWidth < el.scrollWidth - 1 ? "end" : ""].filter(Boolean).join(" ");
      if (ends) el.dataset.more = ends;
      else delete el.dataset.more;
    };
    mark();
    el.addEventListener("scroll", mark, { passive: true });
    const seen = new ResizeObserver(mark);
    seen.observe(el);
    return () => {
      el.removeEventListener("scroll", mark);
      seen.disconnect();
    };
  }, [selector]);
  return ref;
}
