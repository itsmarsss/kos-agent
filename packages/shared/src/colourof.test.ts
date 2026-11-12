import { describe, expect, it } from "vitest";

import { COLOURS, LIGHT_COLOURS } from "./design.js";
import { sameGround, type Rgba } from "./colourof.js";

const hex = (h: string): Rgba => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 1];

describe("sameGround", () => {
  it("takes a near-copy of KOS's ground as KOS's, in either theme", () => {
    // The live cram sheet's paper, dark and light.
    expect(sameGround(hex("#15161a"), hex(COLOURS.bg))).toBe(true);
    expect(sameGround(hex("#f4f3f0"), hex(LIGHT_COLOURS.bg))).toBe(true);
    expect(sameGround(hex(COLOURS.bg), hex(COLOURS.bg))).toBe(true);
  });

  it("keeps a ground meant to be seen as the page's own", () => {
    expect(sameGround(hex(COLOURS.panel), hex(COLOURS.bg))).toBe(false);
    expect(sameGround(hex(COLOURS["panel-2"]), hex(COLOURS.bg))).toBe(false);
    expect(sameGround(hex(LIGHT_COLOURS.panel), hex(LIGHT_COLOURS.bg))).toBe(false);
    // A paper and a cream.
    expect(sameGround(hex("#fbfaf7"), hex(LIGHT_COLOURS.bg))).toBe(false);
    expect(sameGround(hex("#f5efe0"), hex(LIGHT_COLOURS.bg))).toBe(false);
    expect(sameGround(hex("#1b1712"), hex(COLOURS.bg))).toBe(false);
  });
});
