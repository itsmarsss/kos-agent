import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { lookOf } from "@kos/shared";
import { facePixels, facePng } from "./facepng.js";

/** The pixels back out of a PNG this module wrote: unfiltered rows, so the bytes are the pixels. */
function decode(png: Buffer): { size: number; at: (x: number, y: number) => [number, number, number, number] } {
  const size = png.readUInt32BE(16);
  let offset = 8;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "IDAT") idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  return {
    size,
    at: (x, y) => {
      const i = y * (size * 4 + 1) + 1 + x * 4;
      return [raw[i]!, raw[i + 1]!, raw[i + 2]!, raw[i + 3]!];
    },
  };
}

describe("a face as a PNG", () => {
  it("is a PNG of the size asked, the body in its fill, the eyes in its ink, nothing around it", () => {
    const spec = lookOf("recap", { colour: "#3b82f6", eyes: "round", gait: 0 });
    const png = facePng(spec, 64);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const img = decode(png);
    expect(img.size).toBe(64);
    // The middle of the body, below the eyes, is the fill; the corners are empty.
    expect(img.at(32, 44)).toEqual([0x3b, 0x82, 0xf6, 255]);
    expect(img.at(0, 0)[3]).toBe(0);
    expect(img.at(63, 63)[3]).toBe(0);
    // An eye, at its resting place, is the ink.
    const eye = img.at(Math.round(0.64 * (50 + (41 - 50) * spec.shape.spread)), Math.round(0.64 * 48));
    expect(eye[3]).toBe(255);
    expect(eye.slice(0, 3)).not.toEqual([0x3b, 0x82, 0xf6]);
  });

  it("draws a glint on a sparkle, and keeps the same face for the same name", () => {
    const sparkle = facePixels(lookOf("x", { eyes: "sparkle", colour: "#3b82f6", gait: 0 }), 64);
    const plain = facePixels(lookOf("x", { eyes: "half", colour: "#3b82f6", gait: 0 }), 64);
    const white = (px: Uint8Array): number => {
      let n = 0;
      for (let i = 0; i < px.length; i += 4) if (px[i] === 255 && px[i + 1] === 255 && px[i + 2] === 255 && px[i + 3]! > 200) n += 1;
      return n;
    };
    expect(white(sparkle)).toBeGreaterThan(white(plain));
    expect(facePng(lookOf("recap"))).toEqual(facePng(lookOf("recap")));
    expect(facePng(lookOf("recap"))).not.toEqual(facePng(lookOf("watch")));
  });
});
