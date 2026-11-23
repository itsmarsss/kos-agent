/**
 * A finger and the keyboard on screen it types with (docs/design.md, Touch).
 * The sizes are touch.css's; this is what a stylesheet cannot do.
 */

/** A coarse pointer: a phone's or a tablet's finger. */
export const COARSE = "(pointer: coarse)";

/** Whether the pointer is a finger, false where the window cannot be asked. */
export function isCoarse(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(COARSE).matches;
}

/**
 * How much of the window, in px, the keyboard on screen covers: the layout
 * viewport's height less what is visible of it. iOS keeps the layout
 * viewport and shrinks only the visual one; Android shrinks both, and this
 * is then 0, the page already being the room left.
 */
export function keyboardInset(windowHeight: number, visibleHeight: number, visibleTop: number, scale = 1): number {
  // Pinched in, the visible viewport is smaller by the zoom and panned, not covered.
  const seen = scale === 1 ? visibleHeight + visibleTop : visibleHeight * scale;
  return Math.max(0, Math.round(windowHeight - seen));
}

/** How far, in px, a finger travels across before a drawer from the left edge shuts or opens. */
const SWIPE = 56;

/** How near the left edge, in px, a finger comes down for a swipe in to open the drawer from there. */
const EDGE = 24;

/** Whether a finger's travel (`dx` left is negative) is a swipe back to the left edge: far enough, and more across than down. */
export function swipedShut(dx: number, dy: number): boolean {
  return dx <= -SWIPE && Math.abs(dx) > 1.5 * Math.abs(dy);
}

/** Whether a finger that came down at `startX` and travelled `dx`, `dy` swiped in from the left edge, as a phone's drawer opens. */
export function swipedOpen(startX: number, dx: number, dy: number): boolean {
  return startX <= EDGE && dx >= SWIPE && Math.abs(dx) > 1.5 * Math.abs(dy);
}

const EDITABLE = "input, textarea, select, [contenteditable='true']";

/**
 * Keep what is being typed into in sight while the keyboard comes and goes:
 * `--kb-inset` on the root says how much it covers, so a sheet can end above
 * it, and the focused field is scrolled into its scroller's view each time
 * the room changes. A sheet whose foot is pinned under its body hid a field
 * near the bottom behind the foot, the body having shrunk under it.
 */
export function watchKeyboard(win: Window = window): () => void {
  const root = win.document.documentElement;
  const vv = win.visualViewport;
  let frame = 0;
  const settle = (): void => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const inset = vv ? keyboardInset(win.innerHeight, vv.height, vv.offsetTop, vv.scale) : 0;
      root.style.setProperty("--kb-inset", `${inset}px`);
      const field = win.document.activeElement;
      if (isCoarse() && field instanceof HTMLElement && field.matches(EDITABLE)) field.scrollIntoView({ block: "nearest" });
    });
  };
  const onFocus = (e: FocusEvent): void => {
    if (e.target instanceof HTMLElement && e.target.matches(EDITABLE) && isCoarse()) settle();
  };
  vv?.addEventListener("resize", settle);
  win.addEventListener("resize", settle);
  win.document.addEventListener("focusin", onFocus);
  return () => {
    cancelAnimationFrame(frame);
    vv?.removeEventListener("resize", settle);
    win.removeEventListener("resize", settle);
    win.document.removeEventListener("focusin", onFocus);
  };
}

/** The width under which the shell is a phone's: a bar at the top and the nav a drawer (styles.css, 860px). */
export const PHONE = "(max-width: 860px)";

/**
 * Open the menu drawer when a finger swipes in from the window's left edge,
 * on a phone's frame only. `onOpen` is called once per swipe.
 */
export function watchEdgeSwipe(onOpen: () => void, win: Window = window): () => void {
  let from: { x: number; y: number } | null = null;
  const down = (e: TouchEvent): void => {
    const t = e.touches[0];
    from = e.touches.length === 1 && t && win.matchMedia(PHONE).matches ? { x: t.clientX, y: t.clientY } : null;
  };
  const up = (e: TouchEvent): void => {
    const t = e.changedTouches[0];
    if (from && t && swipedOpen(from.x, t.clientX - from.x, t.clientY - from.y)) onOpen();
    from = null;
  };
  win.document.addEventListener("touchstart", down, { passive: true });
  win.document.addEventListener("touchend", up, { passive: true });
  return () => {
    win.document.removeEventListener("touchstart", down);
    win.document.removeEventListener("touchend", up);
  };
}
