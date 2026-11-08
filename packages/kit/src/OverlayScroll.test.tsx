// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { useEffect, useRef, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { overlayScroll, useOverlayScroll } from "./OverlayScroll.js";

/** How long the thumb stays after the last scroll or hover. */
const FADE_MS = 800;

/** jsdom lays nothing out: an element's scrolling, said by hand. */
function scroller(size: { height: number; content: number; top?: number; right?: number }): HTMLElement & { content: number } {
  const el = Object.assign(document.createElement("div"), { content: size.content });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => size.height });
  Object.defineProperty(el, "clientWidth", { configurable: true, get: () => 300 });
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => el.content });
  let top = 0;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(el.content - size.height, v));
    },
  });
  el.getBoundingClientRect = () => ({ left: (size.right ?? 300) - 300, top: size.top ?? 0, width: 300, height: size.height, right: size.right ?? 300, bottom: (size.top ?? 0) + size.height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  document.body.append(el);
  return el;
}

const thumb = (): HTMLElement => document.querySelector<HTMLElement>(".kos-thumb")!;
const px = (v: string): number => Number(v.replace("px", ""));

/** A ResizeObserver jsdom lacks, told by the test when sizes change. */
let resized: (() => void)[] = [];
class FakeResizeObserver {
  constructor(private readonly told: () => void) {
    resized.push(() => this.told());
  }
  observe(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  resized = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("an overlay scrollbar", () => {
  it("hides the native bar and lays a thumb over the edge, sized and placed by the scrolling", () => {
    const el = scroller({ height: 402, content: 1608, top: 50, right: 500 });
    overlayScroll(el);
    expect(el.classList.contains("kos-scroll")).toBe(true);
    expect(thumb().getAttribute("aria-hidden")).toBe("true");
    // Beside the element, so what floats around it stacks above it.
    expect(el.nextElementSibling).toBe(thumb());
    el.dispatchEvent(new Event("scroll"));
    // Track 400 (1 px inset each end), a quarter of the content shown: a 100 px thumb at the top, 4 px wide at the right edge.
    expect(px(thumb().style.height)).toBe(100);
    expect(px(thumb().style.top)).toBe(51);
    expect(px(thumb().style.left)).toBe(500 - 1 - 4);
    el.scrollTop = 1206 / 2;
    el.dispatchEvent(new Event("scroll"));
    expect(px(thumb().style.top)).toBe(51 + 150);
    el.scrollTop = 5_000;
    el.dispatchEvent(new Event("scroll"));
    expect(px(thumb().style.top)).toBe(51 + 300);
  });

  it("follows the content's size, and is gone while nothing overflows", () => {
    const el = scroller({ height: 402, content: 1608 });
    overlayScroll(el);
    el.dispatchEvent(new Event("scroll"));
    el.content = 804;
    for (const tell of resized) tell();
    expect(px(thumb().style.height)).toBe(200);
    el.content = 300;
    for (const tell of resized) tell();
    expect(thumb().dataset.none).toBe("");
    el.dispatchEvent(new Event("scroll"));
    expect(thumb().dataset.shown).toBeUndefined();
  });

  it("shows on scroll or hover and fades soon after, but stays while the pointer is on it", () => {
    vi.useFakeTimers();
    const el = scroller({ height: 402, content: 1608 });
    overlayScroll(el);
    expect(thumb().dataset.shown).toBeUndefined();
    el.dispatchEvent(new Event("scroll"));
    expect(thumb().dataset.shown).toBe("");
    vi.advanceTimersByTime(FADE_MS + 1);
    expect(thumb().dataset.shown).toBeUndefined();

    el.dispatchEvent(new Event("pointerenter"));
    expect(thumb().dataset.shown).toBe("");
    thumb().dispatchEvent(new Event("pointerenter"));
    vi.advanceTimersByTime(FADE_MS * 3);
    expect(thumb().dataset.shown).toBe("");
    thumb().dispatchEvent(new Event("pointerleave"));
    vi.advanceTimersByTime(FADE_MS + 1);
    expect(thumb().dataset.shown).toBeUndefined();
  });

  it("drags: the content moves by as much as the thumb's travel stands for", () => {
    const el = scroller({ height: 402, content: 1608 });
    overlayScroll(el);
    el.dispatchEvent(new Event("scroll"));
    const press = (type: string, y: number): void => {
      const e = new MouseEvent(type, { clientY: y, button: 0, bubbles: true, cancelable: true });
      Object.defineProperty(e, "pointerId", { value: 1 });
      thumb().dispatchEvent(e);
    };
    press("pointerdown", 10);
    expect(thumb().dataset.dragging).toBe("");
    // 300 px of travel stand for 1206 px of content.
    press("pointermove", 10 + 150);
    expect(el.scrollTop).toBeCloseTo(603);
    press("pointerup", 160);
    expect(thumb().dataset.dragging).toBeUndefined();
    press("pointermove", 400);
    expect(el.scrollTop).toBeCloseTo(603);
  });

  it("places nothing while hidden, and once per scroll", () => {
    const el = scroller({ height: 402, content: 1608 });
    let reads = 0;
    const rect = el.getBoundingClientRect.bind(el);
    el.getBoundingClientRect = () => (reads++, rect());
    overlayScroll(el);
    for (const tell of resized) tell();
    expect(reads).toBe(0);
    el.dispatchEvent(new Event("scroll"));
    expect(reads).toBe(1);
    // The element's own scroll reaches the window's capturing listener too; it is placed once for it.
    el.dispatchEvent(new Event("scroll"));
    expect(reads).toBe(2);
    window.dispatchEvent(new Event("resize"));
    expect(reads).toBe(3);
  });

  it("takes no press near the edge: a button there stays pressable, the thumb only under the pointer on it", () => {
    const el = scroller({ height: 402, content: 1608 });
    // A row's "..." whose right edge is 6 px in from the scroller's, as the chats rail draws it.
    const more = document.createElement("button");
    let opened = false;
    more.addEventListener("click", () => void (opened = true));
    el.append(more);
    overlayScroll(el);
    const move = (x: number, y: number): void => void el.dispatchEvent(new MouseEvent("pointermove", { clientX: x, clientY: y, bubbles: true }));
    move(294, 20);
    expect(thumb().dataset.shown).toBe("");
    expect(thumb().dataset.grab).toBeUndefined();
    const down = new MouseEvent("pointerdown", { clientX: 294, clientY: 20, bubbles: true, cancelable: true });
    more.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(false);
    more.click();
    expect(opened).toBe(true);
    // On the thumb as drawn, it takes the press; off it again, it lets go.
    move(297, 20);
    expect(thumb().dataset.grab).toBe("");
    thumb().dispatchEvent(new Event("pointerenter"));
    thumb().dispatchEvent(new Event("pointerleave"));
    expect(thumb().dataset.grab).toBeUndefined();
    // Below the thumb, at the very edge, it only shows.
    move(298, 300);
    expect(thumb().dataset.grab).toBeUndefined();
    // The sheet says so: no press but while shown and grabbed, and low in the stack.
    const css = readFileSync(resolve("packages/kit/src/kit.css"), "utf8");
    expect(css).toMatch(/\.kos-thumb \{[^}]*z-index: 1;[^}]*pointer-events: none;/);
    expect(css).toMatch(/\.kos-thumb\[data-shown\]\[data-grab\] \{ pointer-events: auto;/);
  });

  it("leaves the element's own scrolling alone, and takes everything off again", () => {
    const el = scroller({ height: 402, content: 1608 });
    const wheel = new WheelEvent("wheel", { deltaY: 120, cancelable: true });
    const off = overlayScroll(el);
    el.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
    el.scrollTop = 120;
    expect(el.scrollTop).toBe(120);
    off();
    expect(el.classList.contains("kos-scroll")).toBe(false);
    expect(document.querySelector(".kos-thumb")).toBeNull();
  });

  it("lays itself over an element a component renders, through a ref that also keeps the element", () => {
    let kept: HTMLDivElement | null = null;
    function List(): ReactElement {
      const ref = useRef<HTMLDivElement>(null);
      useEffect(() => void (kept = ref.current));
      return (
        <div ref={useOverlayScroll(ref)}>
          <p>Long</p>
        </div>
      );
    }
    const { unmount } = render(<List />);
    expect(kept!.classList.contains("kos-scroll")).toBe(true);
    expect(document.querySelectorAll(".kos-thumb")).toHaveLength(1);
    unmount();
    expect(document.querySelector(".kos-thumb")).toBeNull();
  });
});
