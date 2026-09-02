import { describe, expect, it, vi } from "vitest";

import { place } from "./Select.js";

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
