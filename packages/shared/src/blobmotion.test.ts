import { describe, expect, it } from "vitest";

import { CENTER, PLAIN_SHAPE, POINTS, RADIUS, outline, smoothPath } from "./blob.js";
import { GAITS } from "./blobmotion.js";

describe("the blob's body", () => {
  it("is one smooth gumdrop at rest, the same every time", () => {
    const a = outline();
    expect(a).toHaveLength(POINTS);
    expect(outline(PLAIN_SHAPE, 0, 0)).toEqual(a);
    for (const [x, y] of a) {
      const r = Math.hypot(x - CENTER.x, y - CENTER.y);
      // Never pointy, never pinched: every point stays close to the circle it is drawn on.
      expect(r).toBeGreaterThanOrEqual(RADIUS * 0.85);
      expect(r).toBeLessThanOrEqual(RADIUS * 1.08);
    }
    // Wider low down than high up: it sits.
    const widthAt = (yFrom: number, yTo: number): number => {
      const xs = a.filter(([, y]) => y >= yFrom && y <= yTo).map(([x]) => x);
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(widthAt(CENTER.y + 8, CENTER.y + 30)).toBeGreaterThan(widthAt(CENTER.y - 30, CENTER.y - 8));
  });

  it("takes a silhouette: wider, or flattened below, with the eyes spread to match", () => {
    const plain = outline();
    const wide = outline({ aspect: 1.12, squat: 0.1, spread: 1 });
    expect(Math.max(...wide.map((p) => p[0]))).toBeGreaterThan(Math.max(...plain.map((p) => p[0])));
    const squat = outline({ aspect: 1, squat: 0.24, spread: 1 });
    expect(Math.max(...squat.map((p) => p[1]))).toBeLessThan(Math.max(...plain.map((p) => p[1])));
  });

  it("wobbles as a jelly does: two sides out, two sides in, and back", () => {
    const rest = outline();
    const bent = outline(PLAIN_SHAPE, 0.1, 0);
    const r = (p: readonly [number, number]): number => Math.hypot(p[0] - CENTER.x, p[1] - CENTER.y);
    // Along the wobble's axis the body is longer; across it, shorter.
    expect(r(bent[0]!)).toBeGreaterThan(r(rest[0]!));
    expect(r(bent[POINTS / 4]!)).toBeLessThan(r(rest[POINTS / 4]!));
    expect(outline(PLAIN_SHAPE, 0, 1.3)).toEqual(rest);
    // The gaits differ in how they carry themselves.
    expect(GAITS).toHaveLength(4);
    expect(new Set(GAITS.map((g) => g.spring)).size).toBe(4);
  });

  it("joins the points into one closed curve with no corners", () => {
    const d = smoothPath(outline());
    expect(d.startsWith("M")).toBe(true);
    expect(d.endsWith(" Z")).toBe(true);
    expect(d.match(/ C/g)).toHaveLength(POINTS);
    expect(smoothPath([[0, 0], [1, 1]])).toBe("");
  });
});
