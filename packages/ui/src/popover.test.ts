import { describe, expect, it, vi } from "vitest";

import { fitInside, place } from "./popover.js";

/**
 * Where the menu goes.
 *
 * It used to be an absolutely positioned child that always opened upward, so
 * in a scrolling card it came out clipped, covered, or over the control it
 * belonged to. Now it is placed against the viewport, which means the
 * arithmetic has to be right.
 */

function viewport(w: number, h: number): void {
  vi.stubGlobal("window", { innerWidth: w, innerHeight: h });
}

function rect(over: Partial<DOMRect>): DOMRect {
  return { top: 0, bottom: 0, left: 0, right: 0, width: 200, height: 30, ...over } as DOMRect;
}

describe("placing a dropdown", () => {
  it("opens below the control when there is room", () => {
    viewport(1200, 800);
    const at = place(rect({ top: 100, bottom: 130, left: 40 }));
    expect(at.top).toBe(136);
    expect(at.bottom).toBeUndefined();
    expect(at.left).toBe(40);
  });

  it("flips above when the control is near the bottom", () => {
    viewport(1200, 800);
    // 60px below and 700 above: opening downward would put the list off
    // the end of the window.
    const at = place(rect({ top: 700, bottom: 740, left: 40 }));
    expect(at.top).toBeUndefined();
    expect(at.bottom).toBe(800 - 700 + 6);
  });

  it("stays below when neither side has much room, if below is bigger", () => {
    viewport(1200, 400);
    const at = place(rect({ top: 150, bottom: 180, left: 0 }));
    expect(at.top).toBe(186);
  });

  it("never runs off the right edge", () => {
    viewport(600, 800);
    // A control near the right of a narrow window: left-aligning the menu to
    // it would push the far side out of view.
    const at = place(rect({ top: 100, bottom: 130, left: 520, width: 200 }));
    expect(at.left).toBe(600 - 200 - 8);
  });

  it("never runs off the left edge either", () => {
    viewport(600, 800);
    const at = place(rect({ top: 100, bottom: 130, left: -50, width: 200 }));
    expect(at.left).toBe(8);
  });

  it("is at least as wide as the control it belongs to", () => {
    viewport(1200, 800);
    expect(place(rect({ top: 10, bottom: 40, width: 320 })).minWidth).toBe(320);
  });

  it("is bounded by the room it has, but never uselessly short", () => {
    viewport(1200, 800);
    const roomy = place(rect({ top: 100, bottom: 130 }));
    expect(roomy.maxHeight).toBe(800 - 130 - 8 - 6);

    // A control jammed against the bottom still gets a usable list rather
    // than a two-pixel sliver.
    const cramped = place(rect({ top: 780, bottom: 795 }));
    expect(cramped.maxHeight).toBeGreaterThanOrEqual(140);
  });
});

/**
 * place() can only clamp by the width of the thing it is anchored to, which
 * is right for a menu that is at least as wide as its button and wrong for a
 * wide card hanging off a 20px bar in a chart. That ran off the right edge
 * with its last column cut off, which is how this was found.
 */
describe("fitting a rendered panel", () => {
  function panel(left: number, width: number): HTMLElement {
    return {
      style: {} as CSSStyleDeclaration,
      getBoundingClientRect: () =>
        ({ left, right: left + width, width }) as DOMRect,
    } as HTMLElement;
  }

  it("pulls a panel back inside the right edge", () => {
    vi.stubGlobal("window", { innerWidth: 1000, innerHeight: 800 });
    const el = panel(900, 260);
    fitInside(el);
    // 900 + 260 = 1160, which is 168 past the 992 it is allowed.
    expect(el.style.left).toBe("732px");
  });

  it("leaves a panel that already fits alone", () => {
    vi.stubGlobal("window", { innerWidth: 1000, innerHeight: 800 });
    const el = panel(100, 260);
    fitInside(el);
    expect(el.style.left).toBe(undefined);
  });

  it("prefers the left edge when the panel cannot fit at all", () => {
    vi.stubGlobal("window", { innerWidth: 200, innerHeight: 800 });
    const el = panel(150, 400);
    fitInside(el);
    // Cut off on one side either way; better the end than the beginning.
    expect(el.style.left).toBe("8px");
  });
});
