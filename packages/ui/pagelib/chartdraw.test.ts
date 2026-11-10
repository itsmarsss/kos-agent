// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { bar } from "./chartdraw.js";

const CATEGORIES = ["Housing", "Groceries", "Dining", "Transport", "Utilities", "Fun", "Health", "Other"];

/** A chart drawn into a box this wide; jsdom lays nothing out, so the labels are measured by their length. */
function draw(width: number, labels: string[], values: number[], height?: number): SVGSVGElement {
  const el = document.createElement("div");
  el.getBoundingClientRect = () => ({ width }) as DOMRect;
  bar(el, { labels, values, ...(height ? { height } : {}) });
  return el.querySelector("svg")!;
}
const viewHeight = (s: SVGSVGElement): number => Number(s.getAttribute("viewBox")!.split(" ")[3]);
const labelsOf = (s: SVGSVGElement, anchor: string): string[] => [...s.querySelectorAll(`text[text-anchor="${anchor}"]`)].map((t) => t.textContent ?? "");
const rects = (s: SVGSVGElement): { width: number; height: number }[] => [...s.querySelectorAll("rect")].map((r) => ({ width: Number(r.getAttribute("width")), height: Number(r.getAttribute("height")) }));

describe("bar", () => {
  const values = CATEGORIES.map((_, i) => 1650 - i * 180);

  it("runs the bars across where the labels do not fit under them, side by side where they do", () => {
    const phone = draw(326, CATEGORIES, values);
    expect(labelsOf(phone, "end")).toEqual(CATEGORIES);
    expect(labelsOf(phone, "middle")).toEqual([]);
    expect(viewHeight(phone)).toBe(8 * 26 + 8);
    expect(phone.querySelectorAll("text:not([text-anchor])")).toHaveLength(8);
    const desktop = draw(1100, CATEGORIES, values);
    expect(labelsOf(desktop, "middle")).toEqual(CATEGORIES);
    expect(viewHeight(desktop)).toBe(220);
  });

  it("draws its geometry left to right on a right-to-left page", () => {
    expect(draw(326, CATEGORIES, values).getAttribute("style")).toBe("direction:ltr");
  });

  it("cuts a label past two fifths of the width, keeping the whole in its title", () => {
    const long = draw(326, ["Household repairs and maintenance", ...CATEGORIES.slice(1)], values);
    const first = long.querySelector('text[text-anchor="end"]')!;
    const shown = first.firstChild!.textContent!;
    expect(shown).toMatch(/^Household.*…$/);
    expect(shown.length * 6.2).toBeLessThanOrEqual(326 * 0.4);
    expect(first.querySelector("title")?.textContent).toBe("Household repairs and maintenance");
  });

  it("draws a negative as no bar, its figure still said", () => {
    for (const s of [draw(326, CATEGORIES, [...values.slice(0, 7), -50]), draw(1100, CATEGORIES, [...values.slice(0, 7), -50])]) {
      expect(rects(s).every((r) => r.width >= 0 && r.height >= 0)).toBe(true);
    }
    expect([...draw(326, CATEGORIES, [...values.slice(0, 7), -50]).querySelectorAll("text")].map((t) => t.textContent)).toContain("-50");
  });

  it("draws a single bar in a column", () => {
    const one = draw(326, ["Housing"], [1650]);
    expect(labelsOf(one, "middle")).toEqual(["Housing"]);
    expect(rects(one)).toHaveLength(1);
  });

  it("fits its rows to a height it is given, and keeps thinned columns when they would be too thin", () => {
    const capped = draw(326, CATEGORIES, values, 150);
    expect(labelsOf(capped, "end")).toEqual(CATEGORIES);
    expect(viewHeight(capped)).toBeCloseTo(150);
    const short = draw(326, CATEGORIES, values, 100);
    expect(labelsOf(short, "end")).toEqual([]);
    expect(viewHeight(short)).toBe(100);
    const shown = labelsOf(short, "middle");
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(8);
    expect(shown[0]).toBe("Housing");
  });
});
