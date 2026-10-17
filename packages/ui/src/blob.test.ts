import { describe, expect, it } from "vitest";

import { CENTER, GAITS, POINTS, RADIUS, outline, smoothPath } from "./blob.js";

describe("the blob's body", () => {
  it("wanders within its gait's reach, the same way for the same seed, and never in step with another", () => {
    const gait = GAITS[0]!;
    const a = outline(1.5, 12345, gait);
    expect(a).toHaveLength(POINTS);
    expect(outline(1.5, 12345, gait)).toEqual(a);
    for (const [x, y] of a) {
      const r = Math.hypot(x - CENTER.x, y - CENTER.y);
      expect(r).toBeGreaterThanOrEqual(RADIUS * (1 - gait.amp * 1.21));
      expect(r).toBeLessThanOrEqual(RADIUS * (1 + gait.amp * 1.21));
    }
    // Time moves it; a different seed is a different blob at the same moment.
    expect(outline(1.6, 12345, gait)).not.toEqual(a);
    expect(outline(1.5, 54321, gait)).not.toEqual(a);
    // The gaits differ in reach and pace.
    expect(GAITS).toHaveLength(4);
    expect(new Set(GAITS.map((g) => g.speed)).size).toBe(4);
  });

  it("joins the points into one closed curve with no corners", () => {
    const d = smoothPath(outline(0, 7, GAITS[1]!));
    expect(d.startsWith("M")).toBe(true);
    expect(d.endsWith(" Z")).toBe(true);
    expect(d.match(/ C/g)).toHaveLength(POINTS);
    expect(smoothPath([[0, 0], [1, 1]])).toBe("");
  });
});
