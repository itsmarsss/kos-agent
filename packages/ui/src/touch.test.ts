import { describe, expect, it } from "vitest";

import { keyboardInset, swipedShut } from "./touch.js";

describe("keyboardInset", () => {
  it("is what the keyboard covers when only the visible viewport shrinks, as on iOS", () => {
    expect(keyboardInset(844, 500, 0)).toBe(344);
  });
  it("counts the visible viewport scrolled down inside the layout one", () => {
    expect(keyboardInset(844, 500, 120)).toBe(224);
  });
  it("is nothing when the whole window shrank, as on Android, or with no keyboard", () => {
    expect(keyboardInset(500, 500, 0)).toBe(0);
    expect(keyboardInset(844, 844, 0)).toBe(0);
  });
  it("is nothing for a pinch zoom, whose visible viewport is smaller by the zoom and panned, not covered", () => {
    expect(keyboardInset(844, 422, 200, 2)).toBe(0);
    expect(keyboardInset(844, 250, 200, 2)).toBe(344);
  });
});

describe("swipedShut", () => {
  it("is a swipe far enough to the left and more across than down", () => {
    expect(swipedShut(-80, 10)).toBe(true);
    expect(swipedShut(-40, 0)).toBe(false);
    expect(swipedShut(80, 0)).toBe(false);
    // A scroll down the drawer that drifts left is a scroll.
    expect(swipedShut(-70, 90)).toBe(false);
  });
});
