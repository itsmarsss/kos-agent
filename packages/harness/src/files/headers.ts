/**
 * What a picture is and how big it is, read from its header alone.
 *
 * Nothing here decodes a picture: a file is known by its magic numbers, and
 * its width and height read where its format keeps them, so a picture too big
 * to decode is refused before a decoder allocates for it, and a TIFF whose
 * directories loop is refused before a decoder follows them round forever.
 */

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

export interface PictureSize {
  width: number;
  height: number;
}

/** The ISO media brands of a HEIF file, by what it holds. */
const AVIF_BRANDS = new Set(["avif", "avis"]);
const HEIC_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx"]);
const HEIF_BRANDS = new Set(["mif1", "msf1"]);
/** BITMAPINFOHEADER and its kin, by size: what makes "BM" a bitmap rather than a text file starting "BM". */
const BMP_HEADERS = new Set([12, 40, 52, 56, 64, 108, 124]);
/** The most directories a TIFF is walked through: a camera's has a handful. */
export const TIFF_DIRECTORIES_MAX = 64;
/** TIFF tags that point at more directories, as the decoder follows them: SubIFDs, Exif, GPS, DNG private data, and Sony's. */
const TIFF_POINTERS = new Set([330, 34665, 34853, 50740, 61440]);

const ascii = (bytes: Uint8Array, from: number, to: number): string => Buffer.from(bytes.subarray(from, to)).toString("latin1");

/** The picture the bytes are, by their magic numbers; undefined for anything else. */
export function imageTypeOf(bytes: Uint8Array): ImageType | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (ascii(bytes, 0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (/^GIF8[79]a$/.test(ascii(bytes, 0, 6))) return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 16 && ascii(bytes, 4, 8) === "ftyp") return heifTypeOf(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  if (ascii(bytes, 0, 4) === "II*\0" || ascii(bytes, 0, 4) === "MM\0*") return "image/tiff";
  if (ascii(bytes, 0, 2) === "BM" && bytes.length > 26 && BMP_HEADERS.has(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).readUInt32LE(14))) return "image/bmp";
  return undefined;
}

/** An ISO media file's picture type, from a well-formed ftyp box's major and compatible brands. */
function heifTypeOf(bytes: Buffer): ImageType | undefined {
  const box = bytes.readUInt32BE(0);
  if (box < 16 || box > bytes.length || box % 4 !== 0) return undefined;
  const brands = [ascii(bytes, 8, 12)];
  for (let at = 16; at + 4 <= box; at += 4) brands.push(ascii(bytes, at, at + 4));
  if (brands.some((b) => AVIF_BRANDS.has(b))) return "image/avif";
  if (brands.some((b) => HEIC_BRANDS.has(b))) return "image/heic";
  if (brands.some((b) => HEIF_BRANDS.has(b))) return "image/heif";
  return undefined;
}

/**
 * The picture's width and height from its header, or undefined when the
 * header does not say. Throws for a TIFF whose directories loop or run past
 * TIFF_DIRECTORIES_MAX.
 */
export function pictureSize(bytes: Buffer, type: ImageType): PictureSize | undefined {
  switch (type) {
    case "image/png":
      return bytes.length >= 24 && ascii(bytes, 12, 16) === "IHDR" ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : undefined;
    case "image/jpeg":
      return jpegSize(bytes);
    case "image/gif":
      // The logical screen, which every frame is drawn on.
      return bytes.length >= 10 ? { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) } : undefined;
    case "image/bmp":
      return bmpSize(bytes);
    case "image/webp":
      return webpSize(bytes);
    case "image/tiff":
      return tiffSize(bytes);
    case "image/heic":
    case "image/heif":
    case "image/avif":
      return heifSize(bytes);
  }
}

function jpegSize(bytes: Buffer): PictureSize | undefined {
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

function bmpSize(bytes: Buffer): PictureSize | undefined {
  // The old OS/2 header keeps its size in 16 bits; every later one in 32, the height signed for a top-down bitmap.
  if (bytes.readUInt32LE(14) === 12) return { width: bytes.readUInt16LE(18), height: bytes.readUInt16LE(20) };
  const width = bytes.readInt32LE(18);
  return width > 0 ? { width, height: Math.abs(bytes.readInt32LE(22)) } : undefined;
}

function webpSize(bytes: Buffer): PictureSize | undefined {
  if (bytes.length < 30) return undefined;
  const chunk = ascii(bytes, 12, 16);
  if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L" && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  return undefined;
}

/**
 * A HEIF's size, from the image spatial extents (ispe) in its meta box: the
 * largest, which is the whole picture's when it is a grid of tiles.
 */
function heifSize(bytes: Buffer): PictureSize | undefined {
  let at = 0;
  while (at + 8 <= bytes.length) {
    let size = bytes.readUInt32BE(at);
    const kind = ascii(bytes, at + 4, at + 8);
    if (size === 1 && at + 16 <= bytes.length) size = Number(bytes.readBigUInt64BE(at + 8));
    else if (size === 0) size = bytes.length - at;
    if (size < 8) return undefined;
    if (kind === "meta") {
      let best: PictureSize | undefined;
      const end = Math.min(bytes.length, at + size);
      for (let i = bytes.indexOf("ispe", at, "latin1"); i >= 0 && i + 16 <= end; i = bytes.indexOf("ispe", i + 4, "latin1")) {
        const found = { width: bytes.readUInt32BE(i + 8), height: bytes.readUInt32BE(i + 12) };
        if (!best || found.width * found.height > best.width * best.height) best = found;
      }
      return best;
    }
    at += size;
  }
  return undefined;
}

/**
 * The first directory's size, after walking every directory the decoder
 * would: each once, at most TIFF_DIRECTORIES_MAX of them, so a file whose
 * directories point back at each other is refused here.
 */
function tiffSize(bytes: Buffer): PictureSize | undefined {
  const le = bytes[0] === 0x49;
  const u16 = (at: number): number => (le ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at));
  const u32 = (at: number): number => (le ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at));
  const seen = new Set<number>();
  // The first directory's, which is the picture the decoder reads.
  let first: PictureSize | undefined;
  const walk = (start: number, chain: boolean): void => {
    for (let at = start; at !== 0; ) {
      if (seen.has(at)) throw new Error("its TIFF directories point back at each other");
      if (seen.size >= TIFF_DIRECTORIES_MAX) throw new Error(`it has more than ${TIFF_DIRECTORIES_MAX} TIFF directories`);
      if (at + 2 > bytes.length) return;
      seen.add(at);
      const count = u16(at);
      if (at + 2 + count * 12 + 4 > bytes.length) return;
      const size: Partial<PictureSize> = {};
      for (let i = 0; i < count; i += 1) {
        const entry = at + 2 + i * 12;
        const tag = u16(entry);
        const type = u16(entry + 2);
        const n = u32(entry + 4);
        const value = (k: number): number => (type === 3 ? u16(entry + 8 + k * 2) : u32(entry + 8 + k * 4));
        if (tag === 256) size.width = value(0);
        if (tag === 257) size.height = value(0);
        if (TIFF_POINTERS.has(tag) && (type === 4 || type === 13)) {
          // Pointers past one live elsewhere in the file, at the offset the entry holds.
          const base = n > 1 ? u32(entry + 8) : entry + 8;
          for (let k = 0; k < Math.min(n, TIFF_DIRECTORIES_MAX); k += 1) {
            if (base + k * 4 + 4 > bytes.length) break;
            walk(u32(base + k * 4), false);
          }
        }
      }
      if (at === root && size.width !== undefined && size.height !== undefined) first = { width: size.width, height: size.height };
      at = chain ? u32(at + 2 + count * 12) : 0;
    }
  };
  if (bytes.length < 8) return undefined;
  const root = u32(4);
  walk(root, true);
  return first;
}
