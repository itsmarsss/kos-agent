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
