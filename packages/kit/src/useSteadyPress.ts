import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/** Where an element sits in the page's layout: its offsets up the chain, which neither a scroll nor a transform changes. */
function layoutPlace(el: HTMLElement): string {
  let top = 0;
  let left = 0;
  for (let at: HTMLElement | null = el; at; at = at.offsetParent as HTMLElement | null) {
    top += at.offsetTop;
    left += at.offsetLeft;
  }
  return `${top},${left}`;
}

/**
 * Whether a press on `ref` now was meant for what it shows: the element has
 * been on screen, in the same place and saying the same thing (`key`), for
 * `ms`, and did not move under a still pointer just before the press. A list
 * that shifts (a card arriving or going, a chat scrolling to its end) then
 * cannot hand a click aimed at one control to the one that slid under it.
 */
export function useSteadyPress(ref: RefObject<HTMLElement | null>, ms: number, key: unknown): () => boolean {
  const since = useRef(0);
  const place = useRef<string | undefined>(undefined);
  // Mounted, or saying something else: wait again.
  useEffect(() => {
    since.current = Date.now();
  }, [key]);
  // Moved in the layout since the last render.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const now = layoutPlace(el);
    if (place.current !== undefined && place.current !== now) since.current = Date.now();
    place.current = now;
  });
  // Moved on screen between the pointer's last move over it and the press: it slid under the pointer.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let seen: { top: number; left: number } | undefined;
    const track = (): void => {
      const r = el.getBoundingClientRect();
      seen = { top: r.top, left: r.left };
    };
    const press = (): void => {
      const r = el.getBoundingClientRect();
      if (seen && (seen.top !== r.top || seen.left !== r.left)) since.current = Date.now();
      seen = { top: r.top, left: r.left };
    };
    const away = (): void => {
      seen = undefined;
    };
    el.addEventListener("pointerover", track, { passive: true });
    el.addEventListener("pointermove", track, { passive: true });
    el.addEventListener("pointerleave", away, { passive: true });
    el.addEventListener("pointerdown", press, { capture: true, passive: true });
    return () => {
      el.removeEventListener("pointerover", track);
      el.removeEventListener("pointermove", track);
      el.removeEventListener("pointerleave", away);
      el.removeEventListener("pointerdown", press, { capture: true });
    };
  }, [ref]);
  return () => Date.now() - since.current >= ms;
}
