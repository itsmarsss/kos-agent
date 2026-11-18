import { useEffect, useRef, type RefObject } from "react";

/**
 * Says which ends of a row that scrolls sideways have more past it, as
 * `data-more` ("start", "end" or both) on the row, so its edge fades there
 * (styles.css): on a phone the last tabs or chips sat off screen with
 * nothing to say they were there.
 *
 * The ref goes on the row itself, or on a wrapper with `selector` naming
 * the row inside it, for a kit piece that takes no ref of its own. A box
 * that scrolls down instead (`axis` "y") is marked `data-more-y`, and its
 * content is watched too, since it can grow under a box of a fixed height.
 */
export function useEdgeFade<T extends HTMLElement>(selector?: string, axis: "x" | "y" = "x"): RefObject<T | null> {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = selector ? ref.current?.querySelector<HTMLElement>(selector) : ref.current;
    if (!el) return;
    const attr = axis === "x" ? "more" : "moreY";
    const mark = (): void => {
      const [at, seen, whole] = axis === "x" ? [el.scrollLeft, el.clientWidth, el.scrollWidth] : [el.scrollTop, el.clientHeight, el.scrollHeight];
      const ends = [at > 1 ? "start" : "", at + seen < whole - 1 ? "end" : ""].filter(Boolean).join(" ");
      if (ends) el.dataset[attr] = ends;
      else delete el.dataset[attr];
    };
    mark();
    el.addEventListener("scroll", mark, { passive: true });
    const seen = new ResizeObserver(mark);
    seen.observe(el);
    if (axis === "y" && el.firstElementChild) seen.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", mark);
      seen.disconnect();
    };
  }, [selector, axis]);
  return ref;
}
