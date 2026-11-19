import { describe, expect, it } from "vitest";

import { pixelBoxes, sameBoxes, steadyShot, upright, type SecretBoxes } from "./boxes.js";
import { paintedJpeg } from "./paint.js";
import { keepFilled, type FilledValue } from "./taint.js";

/** How a picture's boxes are placed on its pixels, and when a page that moves is pictured again. */
describe("the boxes a picture is painted over", () => {
  const view = { width: 1000, height: 800, x: 0, y: 0, scale: 1 };
  const at = (boxes: number[], over: Partial<typeof view> = {}): SecretBoxes => ({ boxes, view: { ...view, ...over } });

  it("are placed on the picture's pixels with room around each, cut to it", () => {
    expect(pixelBoxes(at([100, 50, 200, 40]), { width: 500, height: 400 })).toEqual([48, 23, 104, 24]);
    // A clipped picture says the size it covers; a pinch moves and scales what is drawn.
    expect(pixelBoxes(at([100, 50, 200, 40]), { width: 1000, height: 800 }, { width: 1000, height: 800 })).toEqual([97, 47, 206, 46]);
    expect(pixelBoxes(at([300, 200, 100, 100], { x: 250, y: 150, scale: 2 }), { width: 1000, height: 800 })).toEqual([94, 94, 212, 212]);
    expect(pixelBoxes(at([990, 790, 50, 50]), { width: 1000, height: 800 })).toEqual([987, 787, 13, 13]);
    expect(pixelBoxes(at([2000, 10, 5, 5]), { width: 1000, height: 800 })).toEqual([]);
  });

  it("agree to a pixel, in the same viewport", () => {
    expect(sameBoxes(at([1, 2, 3, 4]), at([1.5, 2, 3, 4.9]))).toBe(true);
    expect(sameBoxes(at([1, 2, 3, 4]), at([3, 2, 3, 4]))).toBe(false);
    expect(sameBoxes(at([1, 2, 3, 4]), at([1, 2, 3, 4, 5, 6, 7, 8]))).toBe(false);
    expect(sameBoxes(at([1, 2, 3, 4]), at([1, 2, 3, 4], { y: 10 }))).toBe(false);
  });

  it("are measured on both sides of the picture, and a page that keeps moving is not pictured", async () => {
    const still = await steadyShot(async () => at([1, 2, 3, 4]), async () => "shot");
    expect(still).toEqual({ shot: "shot", boxes: at([1, 2, 3, 4]) });
    expect(await steadyShot(async () => undefined, async () => "shot")).toEqual({ shot: "shot" });
    let y = 0;
    const settles = [at([0, 0, 1, 1]), at([0, 50, 1, 1]), at([0, 50, 1, 1])];
    let shots = 0;
    const settled = await steadyShot(async () => settles[Math.min(y++, 2)], async () => ++shots);
    expect(settled).toEqual({ shot: 2, boxes: at([0, 50, 1, 1]) });
    let moving = 0;
    await expect(steadyShot(async () => at([moving++ * 10, 0, 1, 1]), async () => "shot")).rejects.toThrow(/kept moving/);
  });
});

describe("a value filled", () => {
  it("is kept once, with every origin it was filled on", () => {
    const values: FilledValue[] = [];
    keepFilled(values, { text: "pw", digits: false, origins: ["https://a.example"] });
    keepFilled(values, { text: "pw", digits: false, origins: ["https://a.example", "https://b.example"] });
    keepFilled(values, { text: "4242", digits: true, origins: ["https://pay.example"] });
    expect(values).toEqual([
      { text: "pw", digits: false, origins: ["https://a.example", "https://b.example"] },
      { text: "4242", digits: true, origins: ["https://pay.example"] },
    ]);
  });
});

describe("a child frame's place", () => {
  it("is an upright rectangle the right way round, or the frame is painted over whole", () => {
    expect(upright([10, 10, 110, 10, 110, 60, 10, 60])).toBe(true);
    // Turned half round, mirrored, or a quarter turn.
    expect(upright([110, 60, 10, 60, 10, 10, 110, 10])).toBe(false);
    expect(upright([110, 10, 10, 10, 10, 60, 110, 60])).toBe(false);
    expect(upright([60, 10, 60, 110, 10, 110, 10, 10])).toBe(false);
  });
});

describe("a picture painted in the host", () => {
  it("is refused past forty million pixels, read from its header", () => {
    const header = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
    header.writeUInt32BE(10_000, 16);
    header.writeUInt32BE(5_000, 20);
    expect(() => paintedJpeg(header.toString("base64"), () => [], 60)).toThrow(/too large/);
  });
});
