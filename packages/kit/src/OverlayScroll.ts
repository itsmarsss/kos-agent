import { useCallback, type RefObject } from "react";

/**
 * Scrollbars as the Mac draws its own: no lane of their own, a thin thumb
 * over the content's edge that shows while it scrolls or the pointer is
 * near it, and fades soon after. Chrome no longer draws these, so the
 * native bar is hidden (`.kos-scroll`) and a thumb is laid over the
 * element's edge: beside the element, in its parent, so the menus and
 * popovers around it stack above it as they did above the native bar (the
 * document's own thumb, for a page that scrolls as a whole, is fixed to the
 * window). The thumb takes no press until the pointer is on the thumb as
 * drawn, so what lies at the content's edge stays pressable. The element
 * scrolls as it always did: wheel, keys and touch are untouched; the thumb
 * is hidden from assistive tech, which reads the element's own scrolling.
 */

/** How long the thumb stays after the last scroll or hover. */
const FADE_MS = 800;
/** The shortest thumb, so a very long page still has one to grab. */
const MIN_THUMB = 28;
/** Space between the thumb and the element's top, bottom and right edges. */
const INSET = 1;
/** The thumb's width at rest; it widens toward the content under the pointer. */
const WIDTH = 4;
/** How near the right edge the pointer shows the thumb. */
const EDGE = 8;

/** Where the thumb was last put, in the window's coordinates, and what its travel stands for. */
interface Bar {
  left: number;
  top: number;
  size: number;
  span: number;
  track: number;
}

/** Lay an overlay thumb over `el`'s scrolling, the document's when `el` is its root. Returns what takes it off again. */
export function overlayScroll(el: HTMLElement): () => void {
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  if (!win) return () => undefined;
  const root = el === doc.documentElement;
  const thumb = doc.createElement("div");
  thumb.className = root ? "kos-thumb kos-thumb--fixed" : "kos-thumb";
  thumb.setAttribute("aria-hidden", "true");
  thumb.style.width = `${WIDTH}px`;
  if (root) doc.body.append(thumb);
  else el.after(thumb);
  el.classList.add("kos-scroll");

  let fade: ReturnType<typeof setTimeout> | undefined;
  let shown = false;
  let near = false;
  let over = false;
  let drag: { y: number; top: number; ratio: number } | undefined;
  let bar: Bar | undefined;

  /** The element's scrolling box in the window's coordinates. */
  const box = (): { top: number; right: number } => {
    if (root) return { top: 0, right: el.clientWidth || win.innerWidth };
    const r = el.getBoundingClientRect();
    return { top: r.top + el.clientTop, right: r.left + el.clientLeft + el.clientWidth };
  };
  /** Where the thumb's own coordinates start, in the window's: its containing block's padding box, else the document. */
  const origin = (): { x: number; y: number } => {
    if (root) return { x: 0, y: 0 };
    const cb = thumb.offsetParent;
    if (!(cb instanceof win.HTMLElement) || (cb === doc.body && win.getComputedStyle(cb).position === "static")) return { x: -win.scrollX, y: -win.scrollY };
    const r = cb.getBoundingClientRect();
    return { x: r.left + cb.clientLeft - cb.scrollLeft, y: r.top + cb.clientTop - cb.scrollTop };
  };
  /** Put the thumb where the element's scrolling says; none when nothing overflows. */
  const place = (): Bar | undefined => {
    const span = el.scrollHeight - el.clientHeight;
    const track = el.clientHeight - 2 * INSET;
    if (span < 1 || track <= MIN_THUMB) {
      thumb.dataset.none = "";
      bar = undefined;
      return undefined;
    }
    delete thumb.dataset.none;
    const size = Math.max(MIN_THUMB, Math.round((track * el.clientHeight) / el.scrollHeight));
    const at = ((track - size) * Math.min(span, Math.max(0, el.scrollTop))) / span;
    const { top, right } = box();
    const o = origin();
    bar = { left: right - INSET - WIDTH, top: Math.round(top + INSET + at), size, span, track };
    thumb.style.height = `${size}px`;
    thumb.style.top = `${bar.top - o.y}px`;
    thumb.style.left = `${bar.left - o.x}px`;
    return bar;
  };
  const hide = (): void => {
    shown = false;
    delete thumb.dataset.shown;
    delete thumb.dataset.grab;
  };
  const hideLater = (): void => {
    clearTimeout(fade);
    fade = setTimeout(() => {
      if (!near && !over && !drag) hide();
    }, FADE_MS);
  };
  const show = (): void => {
    if (!place()) return hide();
    shown = true;
    thumb.dataset.shown = "";
    hideLater();
  };
  /** Whether a point is on the thumb as drawn: never the content's pixels beside it. */
  const onBar = (x: number, y: number): boolean => !!bar && x >= bar.left && x <= bar.left + WIDTH + INSET && y >= bar.top && y <= bar.top + bar.size;

  const target: HTMLElement | Window = root ? win : el;
  const onScroll = (): void => show();
  const onEnter = (): void => show();
  const onMove = (e: PointerEvent): void => {
    const edge = box().right;
    const was = near;
    near = e.clientX >= edge - EDGE && e.clientX <= edge;
    if (near && !was) show();
    else if (was && !near) hideLater();
    // Near the edge only shows it; the thumb takes presses once the pointer is on it.
    if (shown && onBar(e.clientX, e.clientY)) thumb.dataset.grab = "";
  };
  const onLeave = (): void => {
    near = false;
    hideLater();
  };
  // A scroll of an ancestor, or the window's size, can move the element apart from where the thumb was put.
  const onMoved = (e: Event): void => {
    if (shown && e.target !== el) place();
  };
  const onThumbEnter = (): void => void (over = true);
  const onThumbLeave = (): void => {
    over = false;
    if (!drag) delete thumb.dataset.grab;
    hideLater();
  };
  const onDown = (e: PointerEvent): void => {
    if (!bar || e.button !== 0) return;
    e.preventDefault();
    drag = { y: e.clientY, top: el.scrollTop, ratio: bar.span / Math.max(1, bar.track - bar.size) };
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
    if (!over) delete thumb.dataset.grab;
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
  // A hidden thumb is not put anywhere; it is put right when it next shows.
  const sized = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => {
        if (shown && !place()) hide();
      });
  const watch = (): void => {
    if (!sized) return;
    sized.disconnect();
    sized.observe(el);
    for (const child of Array.from(el.children)) sized.observe(child);
  };
  const children = typeof MutationObserver === "undefined" ? undefined : new MutationObserver(watch);
  watch();
  children?.observe(el, { childList: true });

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
