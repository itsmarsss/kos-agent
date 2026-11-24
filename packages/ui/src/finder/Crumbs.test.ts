import { describe, expect, it } from "vitest";

import { shrinkOf } from "./Crumbs.js";

describe("a path's steps giving way", () => {
  it("lets the outer steps give all the overflow before the last gives a pixel", () => {
    // Two steps, the outer 82 px and the last 64, 17 px too wide: the last's share of the overflow.
    const share = (17 * 64 * shrinkOf(1, 2)) / (82 * shrinkOf(0, 2) + 64 * shrinkOf(1, 2));
    expect(share).toBeLessThan(1 / 64);
    expect(shrinkOf(1, 2)).toBe(1);
  });

  it("orders every step outer first, and keeps a deep path's factors finite", () => {
    const n = 12;
    const factors = Array.from({ length: n }, (_, i) => shrinkOf(i, n));
    for (let i = 1; i < 6; i++) expect(factors[n - 1 - i]!).toBeGreaterThan(factors[n - i]!);
    expect(factors.reduce((a, b) => a + b, 0) * 1000).toBeLessThan(3.4e38);
  });
});
