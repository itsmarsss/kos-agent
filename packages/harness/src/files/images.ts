import { imageTypeOf, pictureSize, type ImageType } from "./headers.js";
import { pixels } from "./pixels.js";
import { sips } from "./sips.js";

export { imageTypeOf, pictureSize, type ImageType } from "./headers.js";

/**
 * A picture the owner sends, made into one a model takes.
 *
 * Phones send HEIC, cameras and scanners TIFF, browsers WebP and AVIF; the
 * providers take JPEG and PNG (and GIF and WebP, unevenly), of at most 5 MB
 * each. An iPhone photo was refused as "HEIC not supported", and a large
 * screenshot as past 5 MB. So what the owner sends is kept as it came, in the
 * workspace, and what the model sees is made here: a JPEG or a PNG, its long
 * side at most IMAGE_MAX_SIDE, within IMAGE_MAX_BYTES. The type is read from
 * the bytes, never from the name or what a browser claimed.
 */

const MB = 1024 * 1024;

/**
 * The most a picture sent to a model may be: the providers' 5 MB, measured
 * as it travels, in base64, which is how Anthropic measures it.
 */
export const IMAGE_MAX_BYTES = 5 * MB;

/** The long side a picture is brought down to: past it a provider shrinks it anyway, and bills the bytes first. */
export const IMAGE_MAX_SIDE = 2048;

/** A photo's JPEG quality: no visible loss, a third of the bytes of 100. */
export const JPEG_QUALITY = 85;

/**
 * The most pixels a picture may have to be read at all: a 50 megapixel
 * camera's photo goes; past it, decoding alone takes more memory than a
 * host should give one file, and the model sees 4 megapixels anyway.
 */
export const IMAGE_MAX_PIXELS = 50_000_000;

/** Pictures converted at once: each holds its decoded pixels, up to 200 MB, while it is written out. */
export const CONVERSIONS_AT_ONCE = 2;

/** What a model is sent. */
export type ModelImageType = "image/jpeg" | "image/png";

export interface ModelImage {
  mediaType: ModelImageType;
  data: Buffer;
}

/** A picture read by a converter, ready to be written out at a size. */
export interface OpenPicture {
  width: number;
  height: number;
  /** True when some of it is see-through. */
  alpha: boolean;
  /** The picture as `to`, its long side at most `edge` (never made larger), a JPEG at `quality` of 100. */
  encode(to: ModelImageType, edge: number, quality: number): Promise<Buffer>;
  close(): Promise<void>;
}

/** Reads a picture of any ImageType, refusing one past `maxPixels` as its decoder reports it. */
export interface Converter {
  open(bytes: Buffer, type: ImageType, maxPixels: number): Promise<OpenPicture>;
}

/** The base64 a payload of `bytes` travels as. */
export function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/** A count of things allowed at once, and a queue for the rest. */
class Semaphore {
  private held = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly most: number) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.held >= this.most) await new Promise<void>((go) => this.waiting.push(go));
    else this.held += 1;
    try {
      return await work();
    } finally {
      // Handed straight to the next in line, or given back.
      const next = this.waiting.shift();
      if (next) next();
      else this.held -= 1;
    }
  }
}

const conversions = new Semaphore(CONVERSIONS_AT_ONCE);

/** Pictures that are likely drawn (a screenshot, a diagram, a scan of text): kept sharp as a PNG when one fits. */
const DRAWN = new Set<ImageType>(["image/png", "image/gif", "image/bmp", "image/tiff"]);

const fits = (bytes: Buffer): boolean => base64Length(bytes.byteLength) <= IMAGE_MAX_BYTES;

/** macOS's own sips where there is one (no install, no prompt); everywhere else, decoders in JavaScript and WebAssembly. */
export function converterHere(): Converter {
  return process.platform === "darwin" ? sips : pixels;
}

/**
 * The picture as a model takes it. A JPEG or a PNG already small enough is
 * sent as it is; anything else is read and written out: a drawn picture or
 * one that is see-through as a PNG when that fits, else a JPEG, brought down
 * further until it does.
 */
export async function forModel(bytes: Buffer, converter: Converter = converterHere()): Promise<ModelImage> {
  const type = imageTypeOf(bytes);
  if (!type) throw new Error("its bytes are not a picture KOS reads (JPEG, PNG, GIF, WebP, HEIC, HEIF, AVIF, TIFF or BMP)");
  // Sized from its header before anything decodes it, so a picture too big to hold is refused without being held.
  const size = pictureSize(bytes, type);
  if (!size || !(size.width > 0 && size.height > 0)) throw new Error("its size could not be read from its header");
  if (size.width * size.height > IMAGE_MAX_PIXELS) {
    throw new Error(`it is ${size.width} by ${size.height}, past the ${IMAGE_MAX_PIXELS / 1_000_000} megapixels KOS reads`);
  }
  if ((type === "image/jpeg" || type === "image/png") && fits(bytes) && Math.max(size.width, size.height) <= IMAGE_MAX_SIDE) {
    return { mediaType: type, data: bytes };
  }
  return conversions.run(() => convert(bytes, type, converter));
}

/** A picture read by the converter and written out as the first of a PNG or a JPEG that fits. */
async function convert(bytes: Buffer, type: ImageType, converter: Converter): Promise<ModelImage> {
  const picture = await converter.open(bytes, type, IMAGE_MAX_PIXELS);
  try {
    let edge = Math.min(IMAGE_MAX_SIDE, Math.max(picture.width, picture.height));
    if (DRAWN.has(type) || picture.alpha) {
      const png = await picture.encode("image/png", edge, JPEG_QUALITY);
      if (fits(png)) return { mediaType: "image/png", data: png };
    }
    for (let tries = 0; tries < 4; tries += 1) {
      const jpeg = await picture.encode("image/jpeg", edge, JPEG_QUALITY);
      if (fits(jpeg)) return { mediaType: "image/jpeg", data: jpeg };
      // Bytes go with the area, so the side shrinks by the root of how far over it is, and a little more.
      edge = Math.max(1, Math.floor(edge * Math.sqrt(IMAGE_MAX_BYTES / base64Length(jpeg.byteLength)) * 0.9));
    }
    throw new Error(`it could not be brought under ${IMAGE_MAX_BYTES / MB} MB`);
  } finally {
    await picture.close();
  }
}
