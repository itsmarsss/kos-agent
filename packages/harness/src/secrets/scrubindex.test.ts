import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { buildIndex, ScrubIndex } from "./scrubindex.js";

const key = randomBytes(32);
const values: [string, string][] = Array.from({ length: 50 }, (_, i) => [`s${i}.token`, `tok_${randomBytes(12).toString("hex")}_${i}`]);
const index = new ScrubIndex(key, buildIndex(key, values));

describe("ScrubIndex", () => {
  it("holds no value, and finds one as it is and encoded", () => {
    const file = JSON.stringify(buildIndex(key, values));
    for (const [, v] of values) expect(file).not.toContain(v);
    const [name, value] = values[7]!;
    expect(index.found(`a ${value} b ${Buffer.from(value).toString("base64")}`).text).toBe(`a [secret ${name}] b [secret ${name}]`);
  });

  it("scans a megabyte in one pass, well under a second", () => {
    const filler = "the quick brown fox jumps over the lazy dog 0123456789 ".repeat(20_000).slice(0, 1024 * 1024);
    const [name, value] = values[42]!;
    const text = `${filler}${value}${filler.slice(0, 1000)}`;
    const t0 = performance.now();
    const out = index.found(text);
    const ms = performance.now() - t0;
    expect(out.text).toContain(`[secret ${name}]`);
    expect(ms).toBeLessThan(1_000);
  });

  it("finds a value at any offset of a long text, past 2 MB too", () => {
    const [name, value] = values[3]!;
    for (const at of [2 * 1024 * 1024 - 3, 5 * 1024 * 1024]) {
      const text = `${"x".repeat(at)}${value}tail`;
      const out = index.found(text).text;
      expect(out.endsWith(`[secret ${name}]tail`)).toBe(true);
      expect(out.length).toBe(at + `[secret ${name}]tail`.length);
    }
  }, 30_000);
});
