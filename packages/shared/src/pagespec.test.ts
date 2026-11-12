import { describe, expect, it } from "vitest";

import { outlineOf, widgetSpan } from "./pagespec.js";

describe("a widget page's outline", () => {
  it("takes each widget's own width, or its type's", () => {
    expect(widgetSpan({ type: "stat" })).toBe("quarter");
    expect(widgetSpan({ type: "table", span: "half" })).toBe("half");
    expect(widgetSpan({ type: "chart", span: "wide" })).toBe("full");
    expect(widgetSpan({ type: "unknown" })).toBe("full");
    expect(widgetSpan({ type: "constructor" })).toBe("full");
    expect(widgetSpan({ type: "stat", span: "toString" })).toBe("quarter");
  });

  it("outlines the first dozen widgets, skipping what is not one", () => {
    const widgets = [{ type: "stat" }, null, "x", { span: "half" }, ...Array.from({ length: 14 }, () => ({ type: "table", span: "third" }))];
    const outline = outlineOf({ widgets });
    expect(outline).toHaveLength(12);
    expect(outline[0]).toEqual({ type: "stat", span: "quarter" });
    expect(outline[1]).toEqual({ type: "table", span: "third" });
    expect(outlineOf({})).toEqual([]);
    expect(outlineOf({ widgets: [{ type: "x".repeat(500) }] })[0]!.type).toHaveLength(24);
  });
});
