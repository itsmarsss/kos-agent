import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import { CONVERSIONS_AT_ONCE, IMAGE_MAX_BYTES, IMAGE_MAX_SIDE, base64Length, forModel, imageTypeOf, pictureSize, type Converter } from "./images.js";
import { PICTURES } from "./images.fixture.js";
import { pixels, pixelsConverter } from "./pixels.js";
import { downscale } from "./pixelsworker.js";
import { sips, sipsProfile } from "./sips.js";

const MB = 1024 * 1024;
type Kind = keyof typeof PICTURES;
const picture = (type: Kind): Buffer => Buffer.from(PICTURES[type], "base64");
const TYPES = Object.keys(PICTURES) as Kind[];

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
  return pictureSize(data, type!)!;
}

describe("imageTypeOf", () => {
  it("knows each picture by its bytes", () => {
    for (const type of TYPES) expect(imageTypeOf(picture(type))).toBe(type);
    // A JPEG's head alone is a JPEG: the phone's inbox checks only the first bytes.
    expect(imageTypeOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(imageTypeOf(Buffer.alloc(0))).toBeUndefined();
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

describe("pictureSize", () => {
  it("reads every kind's size from its header, without decoding it", () => {
    for (const type of TYPES) expect(pictureSize(picture(type), type)).toEqual({ width: 24, height: 16 });
  });
});

/** A TIFF of 16 bytes whose one directory names itself as the next: a decoder following it never stops. */
const LOOPING_TIFF = Buffer.from([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 0, 0, 8, 0, 0, 0, 0, 0]);

/** A PNG's signature and header claiming a size, and nothing else. */
function pngClaiming(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.from([0, 0, 0, 13]), Buffer.from("IHDR"), ihdr, Buffer.alloc(4)]);
}

/** A GIF's header claiming a logical screen, and nothing else. */
function gifClaiming(width: number, height: number): Buffer {
  const head = Buffer.alloc(13);
  head.write("GIF89a", 0, "latin1");
  head.writeUInt16LE(width, 6);
  head.writeUInt16LE(height, 8);
  return head;
}

/** A converter that must never be reached. */
const untouched: Converter = {
  open: () => Promise.reject(new Error("the converter was reached")),
};

describe("hostile pictures", () => {
  it("refuses a TIFF whose directories loop, before any decoder follows them", async () => {
    const started = Date.now();
    await expect(forModel(LOOPING_TIFF, untouched)).rejects.toThrow(/TIFF directories point back at each other/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("ends a decoder that never finishes, and says so", async () => {
    // Past the header check, as a file it missed would be: the worker is ended at its time, and KOS lives on.
    await expect(pixelsConverter(1500).open(LOOPING_TIFF, "image/tiff", 50_000_000)).rejects.toThrow(/took more than 1\.5 s/);
  }, 20_000);

  it("refuses a 60000 by 60000 PNG or GIF from its header, quickly and without room made for it", async () => {
    const before = process.memoryUsage().arrayBuffers;
    const started = Date.now();
    await expect(forModel(pngClaiming(60_000, 60_000), untouched)).rejects.toThrow(/60000 by 60000, past the 50 megapixels KOS reads/);
    await expect(forModel(gifClaiming(60_000, 60_000), untouched)).rejects.toThrow(/60000 by 60000, past the 50 megapixels/);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(10 * MB);
  });

  it("refuses a picture whose header gives no size", async () => {
    await expect(forModel(Buffer.from("\x89PNG\r\n\x1a\n\0\0\0\0", "latin1"), untouched)).rejects.toThrow(/size could not be read/);
  });

  it("converts at most two pictures at once", async () => {
    let now = 0;
    let most = 0;
    const counting: Converter = {
      async open() {
        now += 1;
        most = Math.max(most, now);
        await new Promise((r) => setTimeout(r, 20));
        return {
          width: 24,
          height: 16,
          alpha: false,
          encode: async () => picture("image/jpeg"),
          close: async () => {
            now -= 1;
          },
        };
      },
    };
    await Promise.all(Array.from({ length: 6 }, () => forModel(picture("image/heic"), counting)));
    expect(most).toBe(CONVERSIONS_AT_ONCE);
  });

  it("reads 25 HEIC photos without the host's memory growing with them", async () => {
    // Reported: libheif kept its WebAssembly memory for every file.
    await forModel(picture("image/heic"), pixels);
    const before = process.memoryUsage().rss;
    for (let i = 0; i < 25; i += 1) expect((await forModel(picture("image/heic"), pixels)).mediaType).toBe("image/jpeg");
    expect(process.memoryUsage().rss - before).toBeLessThan(100 * MB);
  }, 60_000);
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

  it("refuses a picture past the pixels it is allowed, as its decoder reports it", async () => {
    for (const type of ["image/heic", "image/tiff", "image/gif", "image/jpeg"] as const) {
      await expect(converter.open(picture(type), type, 100)).rejects.toThrow(/24 by 16, past the 0\.0001 megapixels|maxResolutionInMP limit exceeded/);
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

describe.runIf(process.platform === "darwin")("sips's sandbox", () => {
  it("lets sips write its own folder and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "kos-sips-test-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "kos-sips-test-"));
    try {
      writeFileSync(join(dir, "in.png"), picture("image/png"));
      const sandboxed = (out: string): void =>
        void execFileSync("/usr/bin/sandbox-exec", ["-p", sipsProfile(dir), "/usr/bin/sips", "-s", "format", "jpeg", join(dir, "in.png"), "--out", out], { stdio: "ignore" });
      sandboxed(join(dir, "out.jpg"));
      expect(existsSync(join(dir, "out.jpg"))).toBe(true);
      expect(() => sandboxed(join(elsewhere, "out.jpg"))).toThrow();
      expect(existsSync(join(elsewhere, "out.jpg"))).toBe(false);
      expect(sipsProfile(dir)).toContain("(deny network*)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
