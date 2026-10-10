import { describe, expect, it } from "vitest";

import { keyMessages, modifierBits, mouseMessage, toViewport, wheelMessage } from "./browserinput.js";

/**
 * A click on the drawn frame lands on the same spot in the browser, and a
 * key arrives as the key it was, with the character a field needs.
 */
describe("the owner's input to the browser", () => {
  it("maps a point on a letterboxed canvas to the viewport", () => {
    // A 1280x720 page drawn on a 640x480 canvas: scale 0.5, bars of 60px top and bottom.
    const canvas = { width: 640, height: 480 };
    const frame = { width: 1280, height: 720 };
    expect(toViewport({ x: 0, y: 60 }, canvas, frame)).toEqual({ x: 0, y: 0 });
    expect(toViewport({ x: 320, y: 240 }, canvas, frame)).toEqual({ x: 640, y: 360 });
    expect(toViewport({ x: 640, y: 420 }, canvas, frame)).toEqual({ x: 1280, y: 720 });
    // In the bar: clamped to the edge rather than off the page.
    expect(toViewport({ x: 100, y: 10 }, canvas, frame)).toEqual({ x: 200, y: 0 });
    expect(toViewport({ x: 1, y: 1 }, canvas, { width: 0, height: 0 })).toEqual({ x: 0, y: 0 });
  });

  it("builds mouse messages with the button and the modifiers", () => {
    const plain = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
    expect(mouseMessage("mousePressed", { x: 10, y: 20 }, { button: 0, detail: 2, ...plain })).toEqual({
      type: "input_mouse",
      eventType: "mousePressed",
      x: 10,
      y: 20,
      button: "left",
      clickCount: 2,
      modifiers: 0,
    });
    expect(mouseMessage("mouseMoved", { x: 1, y: 2 }, { button: 0, ...plain, shiftKey: true })).toEqual({ type: "input_mouse", eventType: "mouseMoved", x: 1, y: 2, modifiers: 8 });
    expect(wheelMessage({ x: 5, y: 5 }, { deltaX: 0, deltaY: 120.4, ...plain })).toMatchObject({ eventType: "mouseWheel", deltaY: 120 });
    expect(modifierBits({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15);
  });

  it("sends a character after a printable key down, and only the key for a shortcut", () => {
    const plain = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
    expect(keyMessages("keyDown", { key: "a", code: "KeyA", ...plain })).toEqual([
      { type: "input_keyboard", eventType: "keyDown", key: "a", code: "KeyA", modifiers: 0 },
      { type: "input_keyboard", eventType: "char", text: "a", modifiers: 0 },
    ]);
    expect(keyMessages("keyDown", { key: "Enter", code: "Enter", ...plain })).toHaveLength(1);
    expect(keyMessages("keyDown", { key: "c", code: "KeyC", ...plain, metaKey: true })).toEqual([{ type: "input_keyboard", eventType: "keyDown", key: "c", code: "KeyC", modifiers: 4 }]);
    expect(keyMessages("keyUp", { key: "a", code: "KeyA", ...plain })).toHaveLength(1);
  });
});
