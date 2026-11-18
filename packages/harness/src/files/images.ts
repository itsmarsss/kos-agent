import { pixels } from "./pixels.js";
import { sips } from "./sips.js";

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

export type ImageType =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp"
  | "image/heic"
  | "image/heif"
  | "image/avif"
  | "image/tiff"
  | "image/bmp";

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

/** Reads a picture of any ImageType. */
export interface Converter {
  open(bytes: Buffer, type: ImageType): Promise<OpenPicture>;
}

/** The ISO media brands of a HEIF file, by what it holds. */
const AVIF_BRANDS = new Set(["avif", "avis"]);
const HEIC_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx"]);
const HEIF_BRANDS = new Set(["mif1", "msf1"]);
/** BITMAPINFOHEADER and its kin, by size: what makes "BM" a bitmap rather than a text file starting "BM". */
const BMP_HEADERS = new Set([12, 40, 52, 56, 64, 108, 124]);

const ascii = (bytes: Uint8Array, from: number, to: number): string => Buffer.from(bytes.subarray(from, to)).toString("latin1");

/** The picture the bytes are, by their magic numbers; undefined for anything else. */
export function imageTypeOf(bytes: Uint8Array): ImageType | undefined {
  if (bytes.length < 12) return undefined;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (ascii(bytes, 0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (/^GIF8[79]a$/.test(ascii(bytes, 0, 6))) return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  if (ascii(bytes, 4, 8) === "ftyp") return heifTypeOf(bytes);
  if (ascii(bytes, 0, 4) === "II*\0" || ascii(bytes, 0, 4) === "MM\0*") return "image/tiff";
  if (ascii(bytes, 0, 2) === "BM" && bytes.length > 18 && BMP_HEADERS.has(Buffer.from(bytes).readUInt32LE(14))) return "image/bmp";
  return undefined;
}

/** An ISO media file's picture type, from its major and compatible brands. */
function heifTypeOf(bytes: Uint8Array): ImageType | undefined {
  const box = Math.min(bytes.length, Buffer.from(bytes).readUInt32BE(0));
  const brands = [ascii(bytes, 8, 12)];
  for (let at = 16; at + 4 <= box; at += 4) brands.push(ascii(bytes, at, at + 4));
  if (brands.some((b) => AVIF_BRANDS.has(b))) return "image/avif";
  if (brands.some((b) => HEIC_BRANDS.has(b))) return "image/heic";
  if (brands.some((b) => HEIF_BRANDS.has(b))) return "image/heif";
  return undefined;
}

/** The base64 a payload of `bytes` travels as. */
export function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/** Width and height from a PNG's or a JPEG's header, without decoding it. */
export function headerSize(bytes: Buffer, type: ImageType): { width: number; height: number } | undefined {
  if (type === "image/png") return bytes.length >= 24 ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : undefined;
  if (type !== "image/jpeg") return undefined;
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1]!;
    // Fill bytes and markers that carry no length.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      at += 2;
      continue;
    }
    // A start of frame: every SOFn but the huffman (C4), arithmetic (CC) and extension (C8) tables.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    }
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  return undefined;
}

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
  if (type === "image/jpeg" || type === "image/png") {
    const size = headerSize(bytes, type);
    if (fits(bytes) && size && Math.max(size.width, size.height) <= IMAGE_MAX_SIDE) return { mediaType: type, data: bytes };
  }
  const picture = await converter.open(bytes, type);
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
