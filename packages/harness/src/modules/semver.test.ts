import { describe, expect, it } from "vitest";

import { satisfies } from "./semver.js";

describe("satisfies", () => {
  it("matches any for * or empty", () => {
    expect(satisfies("1.2.3", "*")).toBe(true);
    expect(satisfies("9.9.9", "")).toBe(true);
  });

  it("matches exact versions", () => {
    expect(satisfies("1.2.3", "1.2.3")).toBe(true);
    expect(satisfies("1.2.3", "1.2.4")).toBe(false);
  });

  it("handles caret ranges within the same major", () => {
    expect(satisfies("1.4.0", "^1.2.0")).toBe(true);
    expect(satisfies("1.2.0", "^1.2.0")).toBe(true);
    expect(satisfies("1.1.0", "^1.2.0")).toBe(false);
    expect(satisfies("2.0.0", "^1.2.0")).toBe(false);
  });

  it("handles >= ranges", () => {
    expect(satisfies("2.0.0", ">=1.5.0")).toBe(true);
    expect(satisfies("1.4.0", ">=1.5.0")).toBe(false);
  });
});
