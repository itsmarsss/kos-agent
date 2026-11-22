import { describe, expect, it } from "vitest";

import type { Fact } from "./facts.js";
import { freshness, lengthNorm, onePerKey, rarity, standingWeight, withinChars } from "./rank.js";

const DAY = 86_400_000;
const claim = (key: string, over: Partial<Fact> = {}): Fact => ({
  id: 0, userId: "u", key, value: `${key} value`, kind: "fact", scope: "global", source: null, tags: [], pinned: false,
  trust: "owner", confidence: 1, createdAt: 0, updatedAt: 0, supersededAt: null, supersedes: null, lastUsedAt: null, useCount: 0, ...over,
});

describe("rank", () => {
  it("weighs a word by how few claims hold it", () => {
    expect(rarity(1, 50)).toBe(1);
    expect(rarity(15, 50)).toBeLessThan(0.5);
    expect(rarity(50, 50)).toBeLessThan(rarity(15, 50));
    // A store of one claim has nothing to compare against.
    expect(rarity(1, 1)).toBe(1);
  });

  it("counts a long value's words for less, a short one's never for more", () => {
    expect(lengthNorm(500, 500)).toBe(1);
    expect(lengthNorm(50, 500)).toBe(1);
    expect(lengthNorm(1500, 500)).toBeLessThan(0.5);
  });

  it("halves freshness over the half-life by when a claim was stated, never below half", () => {
    const now = 400 * DAY;
    expect(freshness({ updatedAt: now }, now)).toBe(1);
    expect(freshness({ updatedAt: now - 90 * DAY }, now)).toBeCloseTo(0.75);
    expect(freshness({ updatedAt: 0 }, now)).toBeGreaterThan(0.5);
  });

  it("orders the owner's fresh, sure word ahead of an agent's old guess", () => {
    const now = 400 * DAY;
    const owner = standingWeight(claim("a", { updatedAt: now }), now);
    const agent = standingWeight(claim("b", { updatedAt: now - 200 * DAY, trust: "agent", confidence: 0.6 }), now);
    expect(owner).toBeGreaterThan(agent);
  });

  it("answers a key once: the owner's word, then the narrower scope, else the newer", () => {
    const owner = onePerKey([claim("diet", { scope: "global", trust: "owner" }), claim("diet", { scope: "project:food", trust: "agent", updatedAt: 9 })]);
    expect(owner.map((c) => c.scope)).toEqual(["global"]);
    const kept = onePerKey([
      claim("form", { scope: "global", updatedAt: 5 }),
      claim("city", { updatedAt: 1 }),
      claim("form", { scope: "agent:assistant", updatedAt: 1 }),
      claim("city", { updatedAt: 3 }),
    ]);
    expect(kept.map((c) => `${c.scope}/${c.key}/${c.updatedAt}`)).toEqual(["agent:assistant/form/1", "global/city/3"]);
  });

  it("keeps claims within a character budget, never none", () => {
    const long = claim("long", { value: "x".repeat(5000) });
    expect(withinChars([long, claim("a")], 100)).toEqual([long]);
    expect(withinChars([claim("a"), claim("b"), long], 100).map((c) => c.key)).toEqual(["a", "b"]);
    expect(withinChars([], 100)).toEqual([]);
  });
});
