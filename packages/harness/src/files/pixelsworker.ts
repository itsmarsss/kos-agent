import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

import type { HeifImage } from "libheif-js/wasm-bundle.js";

import type { ImageType, PictureSize } from "./headers.js";
import type { ModelImageType } from "./images.js";

/**
 * The worker that reads and writes pictures in JavaScript and WebAssembly,
 * for pixels.ts. It runs apart from KOS because a decoder fed a hostile file
 * can loop or allocate without end, which nothing in the same thread can
 * stop: here it is a worker the main thread ends.
 *
 * Run as it is, without a build (Node strips its types), so it imports
 * nothing of KOS's own but types: everything it needs comes in its messages.
 */

/** What the main thread asks: read a picture, then write it out at a size. */
export type PixelsRequest =
  | { op: "open"; bytes: Uint8Array; type: ImageType; maxPixels: number; size?: PictureSize }
  | { op: "encode"; to: ModelImageType; edge: number; quality: number };

export type PixelsReply =
  | { ok: true; width: number; height: number; alpha: boolean }
  | { ok: true; data: Uint8Array }
  | { ok: false; error: string };

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

/** One libheif decoder for the worker's life: a decoder per file left its WebAssembly memory behind each time. */
let heifDecoder: { decode(bytes: Uint8Array): HeifImage[] } | undefined;

async function heif(bytes: Buffer, maxPixels: number): Promise<Rgba> {
  if (!heifDecoder) heifDecoder = new (await import("libheif-js/wasm-bundle.js")).default.HeifDecoder();
  const images = heifDecoder.decode(bytes);
  try {
    const image = images[0];
    if (!image) throw new Error("no picture in the file");
    const width = image.get_width();
    const height = image.get_height();
    tooBig(width, height, maxPixels);
    const out = await new Promise<Uint8ClampedArray>((resolve, reject) =>
      image.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, (done) => (done ? resolve(done.data) : reject(new Error("libheif could not decode it")))),
    );
    return { width, height, data: new Uint8Array(out.buffer, out.byteOffset, out.byteLength) };
  } finally {
    for (const image of images) image.free();
  }
}

/** Refuse a picture past the pixels KOS decodes, as its decoder reports it. */
function tooBig(width: number, height: number, maxPixels: number): void {
  if (width * height > maxPixels) throw new Error(`it is ${width} by ${height}, past the ${maxPixels / 1_000_000} megapixels KOS reads`);
}

async function decode(bytes: Buffer, type: ImageType, maxPixels: number, size: PictureSize | undefined): Promise<Rgba> {
  switch (type) {
    case "image/jpeg":
      return (await import("jpeg-js")).decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: maxPixels / 1_000_000, maxMemoryUsageInMB: 1024 });
    case "image/png":
      return (await import("pngjs")).PNG.sync.read(bytes);
    case "image/gif": {
      const gif = new (await import("omggif")).GifReader(bytes);
      tooBig(gif.width, gif.height, maxPixels);
      const data = new Uint8Array(gif.width * gif.height * 4);
      // The first frame: what a still of a moving picture shows.
      gif.decodeAndBlitFrameRGBA(0, data);
      return { width: gif.width, height: gif.height, data };
    }
    case "image/webp":
    case "image/avif": {
      // These decoders size nothing before they allocate: the header's size, read by the main thread, is checked first.
      if (size) tooBig(size.width, size.height, maxPixels);
      const read = await (await squash(type === "image/webp" ? "webp" : "avif"))(arrayBuffer(bytes));
      if (!read) throw new Error("the decoder could not read it");
      return { width: read.width, height: read.height, data: new Uint8Array(read.data.buffer, read.data.byteOffset, read.data.byteLength) };
    }
    case "image/heic":
    case "image/heif":
      return heif(bytes, maxPixels);
    case "image/tiff": {
      const { default: UTIF } = await import("utif2");
      const [page] = UTIF.decode(bytes);
      if (!page) throw new Error("no picture in the file");
      // Its first page only, sized from its directory before its pixels are read.
      const tag = (key: string): number => {
        const value = page[key];
        return Array.isArray(value) ? Number(value[0]) : 0;
      };
      tooBig(tag("t256"), tag("t257"), maxPixels);
      UTIF.decodeImage(bytes, page);
      return { width: page.width, height: page.height, data: UTIF.toRGBA8(page) };
    }
    case "image/bmp": {
      // bmp-js hands back each pixel as alpha, blue, green, red, with an alpha that means nothing: a bitmap is opaque.
      const bmp = (await import("bmp-js")).decode(bytes);
      tooBig(bmp.width, bmp.height, maxPixels);
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

/** The picture this worker read, waiting to be written out. */
let image: Rgba | undefined;

async function answer(request: PixelsRequest): Promise<{ reply: PixelsReply; transfer: ArrayBuffer[] }> {
  if (request.op === "open") {
    const bytes = Buffer.from(request.bytes.buffer, request.bytes.byteOffset, request.bytes.byteLength);
    image = await decode(bytes, request.type, request.maxPixels, request.size);
    tooBig(image.width, image.height, request.maxPixels);
    return { reply: { ok: true, width: image.width, height: image.height, alpha: seeThrough(image) }, transfer: [] };
  }
  if (!image) throw new Error("no picture was read");
  const data = new Uint8Array(await encode(downscale(image, request.edge), request.to, request.quality));
  return { reply: { ok: true, data }, transfer: [data.buffer as ArrayBuffer] };
}

// Answers only when pixels.ts started it, so importing this file elsewhere (a test, a test runner's own worker) answers nothing.
const port = workerData === "kos-pixels" ? parentPort : null;
port?.on("message", (request: PixelsRequest) => {
  answer(request).then(
    ({ reply, transfer }) => port.postMessage(reply, transfer),
    (err: unknown) => port.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) } satisfies PixelsReply),
  );
});
