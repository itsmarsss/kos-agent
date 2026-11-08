import { useCallback, type RefObject } from "react";

/**
 * Scrollbars as the Mac draws its own: no lane of their own, a thin thumb
 * over the content's edge that shows while it scrolls or the pointer is
 * over it, and fades soon after. Chrome no longer draws these, so the
 * native bar is hidden (`.kos-scroll`) and a thumb is laid over the
 * element's edge, at the page's top level so nothing inside clips it. The
 * element scrolls as it always did: wheel, keys and touch are untouched;
 * the thumb is only something to see and drag, hidden from assistive tech,
 * which reads the element's own scrolling.
 */

/** How long the thumb stays after the last scroll or hover. */
export const FADE_MS = 800;
/** The shortest thumb, so a very long page still has one to grab. */
const MIN_THUMB = 28;
/** Space between the thumb and the element's top, bottom and right edges. */
const INSET = 2;
/** How near the right edge the pointer keeps the thumb up, so it can be grabbed. */
const EDGE = 16;

/** Lay an overlay thumb over `el`'s scrolling, the document's when `el` is its root. Returns what takes it off again. */
export function overlayScroll(el: HTMLElement): () => void {
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  if (!win) return () => undefined;
  const root = el === doc.documentElement;
  const thumb = doc.createElement("div");
  thumb.className = "kos-thumb";
  thumb.setAttribute("aria-hidden", "true");
  doc.body.append(thumb);
  el.classList.add("kos-scroll");

  let fade: ReturnType<typeof setTimeout> | undefined;
  let near = false;
  let over = false;
  let drag: { y: number; top: number; ratio: number } | undefined;

  const box = (): { top: number; right: number } => {
    if (root) return { top: 0, right: el.clientWidth || win.innerWidth };
    const r = el.getBoundingClientRect();
    return { top: r.top + el.clientTop, right: r.left + el.clientLeft + el.clientWidth };
  };
  /** Where the thumb is and how long, from the element's scrolling now; none when nothing overflows. */
  const place = (): { size: number; span: number; track: number } | undefined => {
    const span = el.scrollHeight - el.clientHeight;
    const track = el.clientHeight - 2 * INSET;
    if (span < 1 || track <= MIN_THUMB) {
      thumb.dataset.none = "";
      delete thumb.dataset.shown;
      return undefined;
    }
    delete thumb.dataset.none;
    const size = Math.max(MIN_THUMB, Math.round((track * el.clientHeight) / el.scrollHeight));
    const at = ((track - size) * Math.min(span, Math.max(0, el.scrollTop))) / span;
    const { top, right } = box();
    thumb.style.height = `${size}px`;
    thumb.style.top = `${Math.round(top + INSET + at)}px`;
    thumb.style.left = `${Math.round(right - INSET - thumb.offsetWidth)}px`;
    return { size, span, track };
  };
  const hideLater = (): void => {
    clearTimeout(fade);
    fade = setTimeout(() => {
      if (!near && !over && !drag) delete thumb.dataset.shown;
    }, FADE_MS);
  };
  const show = (): void => {
    if (!place()) return;
    thumb.dataset.shown = "";
    hideLater();
  };

  const target: HTMLElement | Window = root ? win : el;
  const onScroll = (): void => show();
  const onEnter = (): void => show();
  const onMove = (e: PointerEvent): void => {
    const edge = box().right;
    const was = near;
    near = e.clientX >= edge - EDGE && e.clientX <= edge;
    if (near && !was) show();
    else if (was && !near) hideLater();
  };
  const onLeave = (): void => {
    near = false;
    hideLater();
  };
  // An ancestor's scroll or the window's size moves the element, and the thumb with it.
  const onMoved = (): void => void (thumb.dataset.shown !== undefined && place());
  const onThumbEnter = (): void => void (over = true);
  const onThumbLeave = (): void => {
    over = false;
    hideLater();
  };
  const onDown = (e: PointerEvent): void => {
    const at = place();
    if (!at || e.button !== 0) return;
    e.preventDefault();
    drag = { y: e.clientY, top: el.scrollTop, ratio: at.span / Math.max(1, at.track - at.size) };
    thumb.dataset.dragging = "";
    thumb.setPointerCapture?.(e.pointerId);
  };
  const onDrag = (e: PointerEvent): void => {
    if (drag) el.scrollTop = drag.top + (e.clientY - drag.y) * drag.ratio;
  };
  const onUp = (e: PointerEvent): void => {
    if (!drag) return;
    drag = undefined;
    delete thumb.dataset.dragging;
    if (thumb.hasPointerCapture?.(e.pointerId)) thumb.releasePointerCapture(e.pointerId);
    hideLater();
  };

  target.addEventListener("scroll", onScroll, { passive: true });
  el.addEventListener("pointerenter", onEnter);
  el.addEventListener("pointermove", onMove, { passive: true });
  el.addEventListener("pointerleave", onLeave);
  win.addEventListener("resize", onMoved);
  if (!root) win.addEventListener("scroll", onMoved, { capture: true, passive: true });
  thumb.addEventListener("pointerenter", onThumbEnter);
  thumb.addEventListener("pointerleave", onThumbLeave);
  thumb.addEventListener("pointerdown", onDown);
  thumb.addEventListener("pointermove", onDrag);
  thumb.addEventListener("pointerup", onUp);
  thumb.addEventListener("pointercancel", onUp);

  // The content growing or shrinking changes the thumb's length: the element, and each child as children come and go.
  const sized = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => void place());
  const watch = (): void => {
    if (!sized) return;
    sized.disconnect();
    sized.observe(el);
    for (const child of Array.from(el.children)) sized.observe(child);
  };
  const children = typeof MutationObserver === "undefined" ? undefined : new MutationObserver(watch);
  watch();
  children?.observe(el, { childList: true });
  place();

  return () => {
    clearTimeout(fade);
    sized?.disconnect();
    children?.disconnect();
    target.removeEventListener("scroll", onScroll);
    el.removeEventListener("pointerenter", onEnter);
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerleave", onLeave);
    win.removeEventListener("resize", onMoved);
    if (!root) win.removeEventListener("scroll", onMoved, { capture: true });
    el.classList.remove("kos-scroll");
    thumb.remove();
  };
}

/**
 * A ref that lays the overlay thumb over whatever element it is given, and
 * takes it off when the element goes. `ref`, when given, is kept pointing at
 * the element too, for code that also needs it.
 */
export function useOverlayScroll<T extends HTMLElement>(ref?: RefObject<T | null>): (el: T | null) => (() => void) | undefined {
  return useCallback(
    (el: T | null) => {
      if (ref) ref.current = el;
      if (!el) return undefined;
      const off = overlayScroll(el);
      return () => {
        off();
        if (ref) ref.current = null;
      };
    },
    [ref],
  );
}
