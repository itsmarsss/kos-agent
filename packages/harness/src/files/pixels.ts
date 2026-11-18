import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import type { Converter, ImageType, ModelImageType, OpenPicture } from "./images.js";

/**
 * Pictures read and written in JavaScript and WebAssembly, for a host with
 * no sips: Linux, and the container KOS runs in. Nothing here is a native
 * build, so it installs wherever Node does. Each decoder is loaded the first
 * time a picture of its kind comes, not when KOS starts.
 */

interface Rgba {
  width: number;
  height: number;
  /** Four bytes a pixel, red, green, blue and alpha, row by row. */
  data: Uint8Array;
}

const require = createRequire(import.meta.url);

const arrayBuffer = (bytes: Buffer): ArrayBuffer => new Uint8Array(bytes).buffer;

type Decoder = (buffer: ArrayBuffer) => Promise<{ width: number; height: number; data: Uint8ClampedArray } | null>;

/** jSquash's WebAssembly decoders, each compiled from its file once. */
const squashed = new Map<string, Promise<Decoder>>();

function squash(kind: "webp" | "avif"): Promise<Decoder> {
  let codec = squashed.get(kind);
  if (!codec) {
    codec = (async () => {
      // Handed its WebAssembly as bytes: left to find it, it fetches it by URL, which Node cannot.
      const wasmBinary = arrayBuffer(await readFile(require.resolve(`@jsquash/${kind}/codec/dec/${kind}_dec.wasm`)));
      const module = kind === "webp" ? await import("@jsquash/webp/decode.js") : await import("@jsquash/avif/decode.js");
      await module.init({ wasmBinary });
      return (buffer: ArrayBuffer) => module.default(buffer);
    })();
    squashed.set(kind, codec);
  }
  return codec;
}

async function heif(bytes: Buffer): Promise<Rgba> {
  const { default: libheif } = await import("libheif-js/wasm-bundle.js");
  const [image] = new libheif.HeifDecoder().decode(bytes);
  if (!image) throw new Error("no picture in the file");
  try {
    const width = image.get_width();
    const height = image.get_height();
    const out = await new Promise<Uint8ClampedArray>((resolve, reject) =>
      image.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, (done) => (done ? resolve(done.data) : reject(new Error("libheif could not decode it")))),
    );
    return { width, height, data: new Uint8Array(out.buffer, out.byteOffset, out.byteLength) };
  } finally {
    image.free();
  }
}

async function decode(bytes: Buffer, type: ImageType): Promise<Rgba> {
  switch (type) {
    case "image/jpeg":
      return (await import("jpeg-js")).decode(bytes, { useTArray: true, formatAsRGBA: true });
    case "image/png":
      return (await import("pngjs")).PNG.sync.read(bytes);
    case "image/gif": {
      const gif = new (await import("omggif")).GifReader(bytes);
      const data = new Uint8Array(gif.width * gif.height * 4);
      // The first frame: what a still of a moving picture shows.
      gif.decodeAndBlitFrameRGBA(0, data);
      return { width: gif.width, height: gif.height, data };
    }
    case "image/webp":
    case "image/avif": {
      const read = await (await squash(type === "image/webp" ? "webp" : "avif"))(arrayBuffer(bytes));
      if (!read) throw new Error("the decoder could not read it");
      return { width: read.width, height: read.height, data: new Uint8Array(read.data.buffer, read.data.byteOffset, read.data.byteLength) };
    }
    case "image/heic":
    case "image/heif":
      return heif(bytes);
    case "image/tiff": {
      const { default: UTIF } = await import("utif2");
      const [page] = UTIF.decode(bytes);
      if (!page) throw new Error("no picture in the file");
      UTIF.decodeImage(bytes, page);
      return { width: page.width, height: page.height, data: UTIF.toRGBA8(page) };
    }
    case "image/bmp": {
      // bmp-js hands back each pixel as alpha, blue, green, red, with an alpha that means nothing: a bitmap is opaque.
      const bmp = (await import("bmp-js")).decode(bytes);
      const data = new Uint8Array(bmp.width * bmp.height * 4);
      for (let i = 0; i < data.length; i += 4) {
        data[i] = bmp.data[i + 3]!;
        data[i + 1] = bmp.data[i + 2]!;
        data[i + 2] = bmp.data[i + 1]!;
        data[i + 3] = 255;
      }
      return { width: bmp.width, height: bmp.height, data };
    }
  }
}

/** Whether any pixel is see-through. */
function seeThrough(image: Rgba): boolean {
  for (let i = 3; i < image.data.length; i += 4) if (image.data[i]! < 255) return true;
  return false;
}

/**
 * The picture with its long side at most `edge`, each pixel the average of
 * the ones it covers, weighed by their alpha so a see-through edge does not
 * darken. Never made larger.
 */
export function downscale(image: Rgba, edge: number): Rgba {
  const long = Math.max(image.width, image.height);
  if (long <= edge) return image;
  const width = Math.max(1, Math.round((image.width * edge) / long));
  const height = Math.max(1, Math.round((image.height * edge) / long));
  const src = image.data;
  const data = new Uint8Array(width * height * 4);
  const sx = image.width / width;
  const sy = image.height / height;
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let yy = y0; yy < y1; yy += 1) {
        for (let i = (yy * image.width + x0) * 4, end = (yy * image.width + x1) * 4; i < end; i += 4) {
          const alpha = src[i + 3]!;
          r += src[i]! * alpha;
          g += src[i + 1]! * alpha;
          b += src[i + 2]! * alpha;
          a += alpha;
        }
      }
      const o = (y * width + x) * 4;
      if (a > 0) {
        data[o] = Math.round(r / a);
        data[o + 1] = Math.round(g / a);
        data[o + 2] = Math.round(b / a);
      }
      data[o + 3] = Math.round(a / ((y1 - y0) * (x1 - x0)));
    }
  }
  return { width, height, data };
}

/** The picture laid on white: a JPEG has no alpha, and a see-through screenshot on black is unreadable. */
function onWhite(image: Rgba): Rgba {
  const data = new Uint8Array(image.data.length);
  for (let i = 0; i < data.length; i += 4) {
    const alpha = image.data[i + 3]! / 255;
    for (let c = 0; c < 3; c += 1) data[i + c] = Math.round(image.data[i + c]! * alpha + 255 * (1 - alpha));
    data[i + 3] = 255;
  }
  return { ...image, data };
}

async function encode(image: Rgba, to: ModelImageType, quality: number): Promise<Buffer> {
  if (to === "image/jpeg") return (await import("jpeg-js")).encode(onWhite(image), quality).data;
  const { PNG } = await import("pngjs");
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  return PNG.sync.write(png);
}

export const pixels: Converter = {
  async open(bytes: Buffer, type: ImageType): Promise<OpenPicture> {
    const image = await decode(bytes, type);
    return {
      width: image.width,
      height: image.height,
      alpha: seeThrough(image),
      encode: (to, edge, quality) => encode(downscale(image, edge), to, quality),
      close: async () => {},
    };
  },
};
