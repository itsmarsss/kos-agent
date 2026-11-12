import { describe, expect, it } from "vitest";

import { COLOURS, LIGHT_COLOURS } from "./design.js";
import { sameGround, type Rgba } from "./colourof.js";

const hex = (h: string): Rgba => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 1];
const dark = { bg: hex(COLOURS.bg), kit: [hex(COLOURS.panel), hex(COLOURS["panel-2"])] };
const light = { bg: hex(LIGHT_COLOURS.bg), kit: [hex(LIGHT_COLOURS.panel), hex(LIGHT_COLOURS["panel-2"])] };
const onDark = (h: string): boolean => sameGround(hex(h), dark.bg, dark.kit);
const onLight = (h: string): boolean => sameGround(hex(h), light.bg, light.kit);

describe("sameGround", () => {
  it("takes KOS's ground, and a near-copy of it, as KOS's", () => {
    expect(onDark(COLOURS.bg)).toBe(true);
    expect(onLight(LIGHT_COLOURS.bg)).toBe(true);
    // The live cram sheet's paper, 3.46 and 3.22 from --bg.
    expect(onDark("#15161a")).toBe(true);
    expect(onLight("#f4f3f0")).toBe(true);
    // A plain off-white on light, 2.34 from --bg and no kit surface: KOS's.
    expect(onLight("#fafafa")).toBe(true);
  });

  it("keeps the kit's own surfaces as a ground of the page's own, however near --bg", () => {
    // Light --panel-2 is 2.69 from --bg, nearer than the cram sheet, yet the kit's.
    expect(onLight(LIGHT_COLOURS["panel-2"])).toBe(false);
    expect(onLight("#edeff4")).toBe(false);
    expect(onLight(LIGHT_COLOURS.panel)).toBe(false);
    expect(onDark(COLOURS.panel)).toBe(false);
    expect(onDark(COLOURS["panel-2"])).toBe(false);
  });

  it("keeps a ground meant to be seen as the page's own", () => {
    expect(onLight("#f5efe0")).toBe(false);
    expect(onDark("#1b1712")).toBe(false);
    expect(onDark("#11141b")).toBe(false);
  });
});
