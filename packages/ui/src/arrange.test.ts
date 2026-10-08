import { describe, expect, it } from "vitest";

import { hitBox, moveItem, moveTo, spanFor, withSpan, type Box } from "./arrange.js";

/**
 * Arranging the home page by hand.
 *
 * The pointer handling is thin; these are the rules under it, which decide
 * where a carried panel lands and what width a pulled edge becomes.
 */
describe("where a dragged edge snaps", () => {
  it("lands on the nearest of the four widths", () => {
    expect(spanFor(0.2)).toBe("quarter");
    expect(spanFor(0.3)).toBe("third");
    expect(spanFor(0.45)).toBe("half");
    expect(spanFor(0.7)).toBe("half");
    expect(spanFor(0.8)).toBe("full");
    expect(spanFor(1.4)).toBe("full");
    expect(spanFor(-1)).toBe("quarter");
  });
});

describe("moving a panel", () => {
  const list = ["a", "b", "c", "d"];

  it("puts the item at the slot it was dropped on, shifting the rest", () => {
    expect(moveItem(list, 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(list, 3, 0)).toEqual(["d", "a", "b", "c"]);
  });

  it("leaves the list alone for a move that goes nowhere", () => {
    expect(moveItem(list, 1, 1)).toBe(list);
    expect(moveItem(list, 1, 9)).toBe(list);
    expect(moveItem(list, -1, 1)).toBe(list);
  });

  it("moves by id, so a reorder survives a re-render in between", () => {
    const panels = list.map((id) => ({ id, kind: "note" as const, span: "half" as const }));
    expect(moveTo(panels, "d", "b").map((p) => p.id)).toEqual(["a", "d", "b", "c"]);
    expect(moveTo(panels, "d", "zz")).toBe(panels);
  });

  it("changes one panel's width and returns the same list when nothing changed", () => {
    const panels = list.map((id) => ({ id, kind: "note" as const, span: "half" as const }));
    expect(withSpan(panels, "b", "full")[1]?.span).toBe("full");
    expect(withSpan(panels, "b", "half")).not.toBe(panels);
    expect(withSpan(panels, "b", "half")).toEqual(panels);
  });
});

describe("the cell under the pointer", () => {
  const boxes: Box[] = [
    { id: "a", left: 0, top: 0, width: 100, height: 50 },
    { id: "b", left: 100, top: 0, width: 100, height: 50 },
    { id: "c", left: 0, top: 50, width: 200, height: 50 },
  ];

  it("finds the box a point is in, with edges belonging to the next box", () => {
    expect(hitBox(boxes, 10, 10)?.id).toBe("a");
    expect(hitBox(boxes, 100, 10)?.id).toBe("b");
    expect(hitBox(boxes, 150, 60)?.id).toBe("c");
    expect(hitBox(boxes, 250, 60)).toBeUndefined();
  });
});
