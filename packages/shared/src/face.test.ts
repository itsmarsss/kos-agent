import { describe, expect, it } from "vitest";

import { bodyHexOf, hashName, hexOfHsl, hueOfName, lightnessOf } from "./face.js";

describe("a face's colour", () => {
  it("gives a name the same number everywhere", () => {
    expect(hashName("recap")).toBe(hashName("recap"));
    expect(hashName("recap")).not.toBe(hashName("research"));
    expect(hueOfName("Recap ")).toBe(hashName("recap") % 360);
    expect(hueOfName("kos")).toBe(214);
    expect(hueOfName("")).toBe(214);
  });

  it("writes hsl as hex, and keeps the lightness off mustard and murk", () => {
    expect(hexOfHsl(0, 100, 50)).toBe("#ff0000");
    expect(hexOfHsl(120, 100, 50)).toBe("#00ff00");
    expect(hexOfHsl(-120, 100, 50)).toBe("#0000ff");
    expect(lightnessOf(75)).toBe(64);
    expect(lightnessOf(255)).toBe(56);
  });

  it("is the picked colour when there is one, else the hue's own fill", () => {
    expect(bodyHexOf("recap", { colour: "#3B82F6" })).toBe("#3b82f6");
    expect(bodyHexOf("recap", { colour: "blue", hue: 0 })).toBe(hexOfHsl(0, 84, lightnessOf(0)));
    expect(bodyHexOf("recap", { hue: 370 })).toBe(bodyHexOf("recap", { hue: 10 }));
    expect(bodyHexOf("recap")).toBe(hexOfHsl(hueOfName("recap"), 84, lightnessOf(hueOfName("recap"))));
    expect(bodyHexOf("recap")).toMatch(/^#[0-9a-f]{6}$/);
  });
});
