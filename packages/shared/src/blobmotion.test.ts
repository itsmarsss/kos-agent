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
    const wide = outline({ ...PLAIN_SHAPE, aspect: 1.12 });
    expect(Math.max(...wide.map((p) => p[0]))).toBeGreaterThan(Math.max(...plain.map((p) => p[0])));
    const squat = outline({ ...PLAIN_SHAPE, squat: 0.24 });
    expect(Math.max(...squat.map((p) => p[1]))).toBeLessThan(Math.max(...plain.map((p) => p[1])));
  });

  it("draws a lumpy outline point for point as KOS for Mac does (BlobMotionTests.swift checks the same)", () => {
    const pts = outline({ aspect: 1.02, squat: 0.12, spread: 1, lobes: [{ k: 3, amp: 0.05, phase: 0.4 }, { k: 2, amp: 0.04, phase: 1.1 }] });
    for (const [i, x, y] of [[0, 88.5498, 52], [3, 65.8268, 85.4294], [12, 50, 11.3346]] as const) {
      expect(pts[i]![0]).toBeCloseTo(x, 3);
      expect(pts[i]![1]).toBeCloseTo(y, 3);
    }
  });

  it("takes its lumps above more than below, so it still sits flat", () => {
    const lumpy = outline({ ...PLAIN_SHAPE, lobes: [{ k: 2, amp: 0.08, phase: Math.PI / 2 }] });
    const plain = outline();
    const r = (p: readonly [number, number]): number => Math.hypot(p[0] - CENTER.x, p[1] - CENTER.y);
    // Straight up and straight down are both crests of a two-lobed lump.
    const up = r(lumpy[(3 * POINTS) / 4]!) - r(plain[(3 * POINTS) / 4]!);
    const down = r(lumpy[POINTS / 4]!) - r(plain[POINTS / 4]!);
    expect(up).toBeGreaterThan(0);
    expect(down).toBeGreaterThan(0);
    expect(down).toBeLessThan(up / 2);
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
