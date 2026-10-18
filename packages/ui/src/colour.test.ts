import { describe, expect, it } from "vitest";

import { hexOfHsl, hueOfHex } from "./colour.js";

describe("colour", () => {
  it("reads the hue out of a hex colour, and has none for a grey or a non-colour", () => {
    expect(hueOfHex("#ff0000")).toBe(0);
    expect(hueOfHex("#00ff00")).toBe(120);
    expect(hueOfHex("0000ff")).toBe(240);
    expect(hueOfHex("#FFA500")).toBe(39);
    expect(hueOfHex("#808080")).toBeNull();
    expect(hueOfHex("#fff")).toBeNull();
    expect(hueOfHex("blue")).toBeNull();
  });

  it("writes a hex colour from hsl", () => {
    expect(hexOfHsl(0, 100, 50)).toBe("#ff0000");
    expect(hexOfHsl(120, 100, 50)).toBe("#00ff00");
    expect(hexOfHsl(240, 100, 50)).toBe("#0000ff");
    expect(hexOfHsl(0, 0, 50)).toBe("#808080");
    expect(hexOfHsl(-120, 100, 50)).toBe("#0000ff");
  });

  it("round-trips a hue through the blob's own saturation and lightness", () => {
    for (const hue of [0, 24, 48, 90, 150, 180, 214, 250, 285, 330, 359]) {
      const back = hueOfHex(hexOfHsl(hue, 84, 60))!;
      const apart = Math.min(Math.abs(back - hue), 360 - Math.abs(back - hue));
      expect(apart, `hue ${hue} came back as ${back}`).toBeLessThanOrEqual(1);
    }
  });
});
