import { describe, expect, it } from "vitest";

import { isConvex, outline, smoothPolygon } from "./blob.js";
import { SHAPE_WORD_MAX, bodyHexOf, hashName, hexOfHsl, hueOfName, lightnessOf, lookOf, shapeOf, shapeWordOf } from "./face.js";

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

describe("a silhouette from a word", () => {
  const words = Array.from({ length: 400 }, (_, i) => `word${i}`);

  it("is the same creature for the same word, and another for another", () => {
    expect(shapeOf("Mochi ")).toEqual(shapeOf("mochi"));
    expect(shapeOf("mochi")).not.toEqual(shapeOf("tofu"));
    expect(shapeOf("mochi").lobes.map((l) => l.k)).toEqual([2, 3, 4]);
  });

  it("is lumpy but never dented: every outline bulges out all round", () => {
    for (const word of words) {
      const shape = shapeOf(word);
      expect(isConvex(smoothPolygon(outline(shape))), word).toBe(true);
      for (const lobe of shape.lobes) expect(lobe.amp).toBeLessThanOrEqual(0.09);
    }
    // Eased only as far as it has to be: most words keep visible lumps.
    const lumpy = words.filter((w) => shapeOf(w).lobes.reduce((sum, l) => sum + l.amp, 0) > 0.05);
    expect(lumpy.length).toBeGreaterThan(words.length * 0.7);
  });

  it("keeps a blob's old proportions, and adds its lumps", () => {
    const g = hashName("recap#");
    expect(lookOf("recap").shape).toMatchObject({ aspect: 0.92 + ((g % 100) / 100) * 0.2, squat: ((g >>> 10) % 3) * 0.12 });
    expect(lookOf("recap").shape.lobes.length).toBe(3);
  });

  it("leaves KOS the plain gumdrop until it is given a word", () => {
    expect(lookOf("kos").shape.lobes).toEqual([]);
    expect(lookOf("kos").shapeWord).toBeUndefined();
    const given = lookOf("kos", { shape: "cloud" });
    expect(given.shape).toEqual(shapeOf("cloud"));
    expect(given.shapeWord).toBe("cloud");
    // A blob given a word wears that word's outline, not its name's.
    expect(lookOf("recap", { shape: "cloud" }).shape).toEqual(shapeOf("cloud"));
    expect(lookOf("recap", { shape: "  " }).shape).toEqual(shapeOf("recap"));
  });

  it("keeps a word as one line of plain words", () => {
    expect(shapeWordOf("  tiny,  moon \n")).toBe("tiny moon");
    expect(shapeWordOf(" , ")).toBeUndefined();
    expect(shapeWordOf("x".repeat(60))).toHaveLength(SHAPE_WORD_MAX);
  });
});
