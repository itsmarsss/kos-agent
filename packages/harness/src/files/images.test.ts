import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import { IMAGE_MAX_BYTES, IMAGE_MAX_SIDE, base64Length, forModel, headerSize, imageTypeOf, type Converter, type ImageType } from "./images.js";
import { PICTURES } from "./images.fixture.js";
import { downscale, pixels } from "./pixels.js";
import { sips } from "./sips.js";

const MB = 1024 * 1024;
const picture = (type: ImageType): Buffer => Buffer.from(PICTURES[type], "base64");
const TYPES = Object.keys(PICTURES) as ImageType[];

/** Noise, which no encoder can make small: a PNG of it is about as big as its pixels. */
function noisyPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  let seed = 7;
  for (let i = 0; i < png.data.length; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    png.data[i] = (i & 3) === 3 ? 255 : seed >> 16;
  }
  return PNG.sync.write(png, { deflateLevel: 1 });
}

/** The size of what came out, read back from its own header. */
function sizeOf(data: Buffer): { width: number; height: number } {
  const type = imageTypeOf(data);
  expect(type === "image/jpeg" || type === "image/png").toBe(true);
  return headerSize(data, type!)!;
}

describe("imageTypeOf", () => {
  it("knows each picture by its bytes", () => {
    for (const type of TYPES) expect(imageTypeOf(picture(type))).toBe(type);
  });

  it("reads a HEIF's brands: an iPhone's mif1 file that holds HEVC is a HEIC", () => {
    const ftyp = (major: string, ...compatible: string[]): Buffer => {
      const body = Buffer.from(`ftyp${major}\0\0\0\0${compatible.join("")}`, "latin1");
      const box = Buffer.alloc(4);
      box.writeUInt32BE(body.length + 4);
      return Buffer.concat([box, body, Buffer.alloc(16)]);
    };
    expect(imageTypeOf(ftyp("mif1", "heic", "mif1"))).toBe("image/heic");
    expect(imageTypeOf(ftyp("heix", "mif1"))).toBe("image/heic");
    expect(imageTypeOf(ftyp("msf1", "msf1"))).toBe("image/heif");
    expect(imageTypeOf(ftyp("mif1", "avif"))).toBe("image/avif");
    // An MP4 is an ISO media file too, and not a picture.
    expect(imageTypeOf(ftyp("isom", "mp41"))).toBeUndefined();
  });

  it("does not take a text file for a bitmap because it starts with BM", () => {
    expect(imageTypeOf(Buffer.from("BMW service history, 2019 to 2024"))).toBeUndefined();
    expect(imageTypeOf(Buffer.from("%PDF-1.7 and the rest"))).toBeUndefined();
  });
});

describe("headerSize", () => {
  it("reads a JPEG's and a PNG's size without decoding them", () => {
    expect(headerSize(picture("image/jpeg"), "image/jpeg")).toEqual({ width: 24, height: 16 });
    expect(headerSize(picture("image/png"), "image/png")).toEqual({ width: 24, height: 16 });
  });
});

describe("downscale", () => {
  it("averages what each pixel covers, by alpha, and never makes a picture larger", () => {
    const image = { width: 4, height: 2, data: new Uint8Array(32) };
    // Left half opaque red, right half clear: a clear pixel's colour does not bleed in.
    for (let i = 0; i < 8; i += 1) image.data.set(i % 4 < 2 ? [255, 0, 0, 255] : [0, 0, 255, 0], i * 4);
    const half = downscale(image, 2);
    expect([half.width, half.height]).toEqual([2, 1]);
    expect(Array.from(half.data)).toEqual([255, 0, 0, 255, 0, 0, 0, 0]);
    expect(downscale(image, 10)).toBe(image);
  });
});

const converters: [string, Converter][] = [["pixels", pixels], ...(process.platform === "darwin" ? [["sips", sips] as [string, Converter]] : [])];

describe.each(converters)("forModel with %s", (_, converter) => {
  it("makes every kind KOS takes into a JPEG or a PNG of the same size", async () => {
    for (const type of TYPES) {
      const out = await forModel(picture(type), converter);
      expect(out.mediaType).toBe(imageTypeOf(out.data));
      expect(sizeOf(out.data)).toEqual({ width: 24, height: 16 });
    }
  });

  it("sends an iPhone's HEIC photo as a JPEG", async () => {
    const out = await forModel(picture("image/heic"), converter);
    expect(out.mediaType).toBe("image/jpeg");
  });

  it("sends a small JPEG or PNG as it is", async () => {
    for (const type of ["image/jpeg", "image/png"] as const) {
      expect((await forModel(picture(type), converter)).data.equals(picture(type))).toBe(true);
    }
  });

  it("brings a 12 MB PNG down under the providers' 5 MB and 2048 px", async () => {
    // Reported: a large screenshot was refused at 5 MB rather than made to fit.
    const big = noisyPng(2600, 1600);
    expect(big.byteLength).toBeGreaterThan(12 * MB);
    const out = await forModel(big, converter);
    expect(base64Length(out.data.byteLength)).toBeLessThanOrEqual(IMAGE_MAX_BYTES);
    expect(sizeOf(out.data).width).toBe(IMAGE_MAX_SIDE);
    expect(sizeOf(out.data).height).toBe(1260);
  }, 120_000);

  it("refuses what is not a picture, and a picture its decoder cannot read, saying why", async () => {
    await expect(forModel(Buffer.from("plain words, not a picture"), converter)).rejects.toThrow(/not a picture KOS reads/);
    const broken = Buffer.concat([picture("image/heic").subarray(0, 40), Buffer.alloc(200)]);
    await expect(forModel(broken, converter)).rejects.toThrow(/./);
  });
});
