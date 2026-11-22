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
/** `ready` is for an element drawn only once something has loaded: the row is looked for again when it turns true. */
export function useEdgeFade<T extends HTMLElement>(selector?: string, axis: "x" | "y" = "x", ready = true): RefObject<T | null> {
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
    // A row's own box keeps its width while what is in it grows (a face loading, a count arriving): watch the items too.
    if (axis === "x") for (const item of el.children) seen.observe(item);
    return () => {
      el.removeEventListener("scroll", mark);
      seen.disconnect();
    };
  }, [selector, axis, ready]);
  return ref;
}

/**
 * Scroll a row that scrolls sideways so its chosen item is in sight, by the
 * row alone (the page does not move): on a phone a tab chosen past the edge,
 * by a link or a search, was chosen out of sight.
 */
export function showChosen(row: HTMLElement | null, selector: string): void {
  const on = row?.querySelector<HTMLElement>(selector);
  if (!row || !on || row.scrollWidth <= row.clientWidth) return;
  const left = on.offsetLeft - row.offsetLeft;
  if (left >= row.scrollLeft && left + on.offsetWidth <= row.scrollLeft + row.clientWidth) return;
  row.scrollLeft = Math.max(0, left - (row.clientWidth - on.offsetWidth) / 2);
}
