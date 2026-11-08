// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { useEffect, useRef, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FADE_MS, overlayScroll, useOverlayScroll } from "./OverlayScroll.js";

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
    const el = scroller({ height: 404, content: 1616, top: 50, right: 500 });
    overlayScroll(el);
    expect(el.classList.contains("kos-scroll")).toBe(true);
    expect(thumb().getAttribute("aria-hidden")).toBe("true");
    // Track 400 (2 px inset each end), a quarter of the content shown: a 100 px thumb at the top.
    expect(px(thumb().style.height)).toBe(100);
    expect(px(thumb().style.top)).toBe(52);
    el.scrollTop = 1212 / 2;
    el.dispatchEvent(new Event("scroll"));
    expect(px(thumb().style.top)).toBe(52 + 150);
    el.scrollTop = 5_000;
    el.dispatchEvent(new Event("scroll"));
    expect(px(thumb().style.top)).toBe(52 + 300);
  });

  it("follows the content's size, and is gone while nothing overflows", () => {
    const el = scroller({ height: 404, content: 1616 });
    overlayScroll(el);
    el.content = 808;
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
    const el = scroller({ height: 404, content: 1616 });
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
    const el = scroller({ height: 404, content: 1616 });
    overlayScroll(el);
    const press = (type: string, y: number): void => {
      const e = new MouseEvent(type, { clientY: y, button: 0, bubbles: true, cancelable: true });
      Object.defineProperty(e, "pointerId", { value: 1 });
      thumb().dispatchEvent(e);
    };
    press("pointerdown", 10);
    expect(thumb().dataset.dragging).toBe("");
    // 300 px of travel stand for 1212 px of content.
    press("pointermove", 10 + 150);
    expect(el.scrollTop).toBe(606);
    press("pointerup", 160);
    expect(thumb().dataset.dragging).toBeUndefined();
    press("pointermove", 400);
    expect(el.scrollTop).toBe(606);
  });

  it("leaves the element's own scrolling alone, and takes everything off again", () => {
    const el = scroller({ height: 404, content: 1616 });
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
