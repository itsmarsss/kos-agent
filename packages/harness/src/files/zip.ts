import { deflateRawSync, inflateRawSync } from "node:zlib";

import { crc32 } from "./crc32.js";

/**
 * A zip archive, read.
 *
 * An Office document is a zip of XML files, and that is all a reader of one
 * needs: the central directory at the end names the entries, each local
 * header says where its bytes start, and the bytes are stored or deflated.
 * Nothing else of the format is used, so nothing else of it is parsed: no
 * encryption, no spans, no zip64, each refused by name rather than read
 * wrong.
 */

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
/** Past this an entry is left out: a document's text is never this large, and a bomb is. */
const ENTRY_MAX = 64 * 1024 * 1024;

/** Enough of the file's head to know it is a zip. */
export function isZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** How much a reader lets an archive hold. */
export interface ZipLimits {
  /** The most one entry may inflate to. */
  entryMax?: number;
  /** The most all entries together may inflate to; past it the archive is refused. */
  totalMax?: number;
  /** An entry past entryMax: left out (a text reader's way) or the archive refused (a viewer's). */
  oversize?: "skip" | "refuse";
  /** Only the entries this keeps are inflated: a preview out of a large package without the rest. */
  only?: (name: string) => boolean;
}

/** Thrown for an archive that inflates past its limits: a zip bomb, or near enough. */
export class ZipTooLarge extends Error {}

/** The entries by name, each decompressed; a folder entry carries no bytes and is left out. */
export function readZip(bytes: Uint8Array, { entryMax = ENTRY_MAX, totalMax = Infinity, oversize = "skip", only }: ZipLimits = {}): Map<string, Buffer> {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = endRecord(buf);
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  let total = 0;
  for (let n = 0; n < count; n += 1) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL) throw new Error("not a zip: the central directory is broken");
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/") || (only && !only(name))) continue;
    if (flags & 0x1) throw new Error(`${name} is encrypted`);
    if (size > entryMax || compressed > entryMax) {
      if (oversize === "refuse") throw new ZipTooLarge(`${name} is larger than a document holds`);
      continue;
    }
    // What the directory says is checked before anything is inflated, and each inflation is held to what is left.
    if (total + size > totalMax) throw new ZipTooLarge(`it inflates past ${Math.round(totalMax / 1024 / 1024)} MB`);
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOCAL) throw new Error(`not a zip: ${name} has no local header`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + compressed);
    let entry: Buffer;
    if (method === 0) entry = Buffer.from(data);
    else if (method === 8) entry = inflate(data, name, Math.min(entryMax, Number.isFinite(totalMax) ? Math.max(1, totalMax - total) : entryMax));
    else throw new Error(`${name} is compressed a way this reader does not know (method ${method})`);
    // The sizes the directory gives can lie; what was inflated cannot.
    total += entry.length;
    if (total > totalMax) throw new ZipTooLarge(`it inflates past ${Math.round(totalMax / 1024 / 1024)} MB`);
    out.set(name, entry);
  }
  return out;
}

/** An entry inflated, never past `max`, whatever its header claimed. */
function inflate(data: Buffer, name: string, max: number): Buffer {
  try {
    return inflateRawSync(data, { maxOutputLength: max });
  } catch (err) {
    if (err instanceof RangeError || (err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw new ZipTooLarge(`${name} inflates past what a document holds`);
    throw err;
  }
}

/** Where the end-of-central-directory record starts: scanned back from the end, past any comment. */
function endRecord(buf: Buffer): number {
  const floor = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= floor; i -= 1) {
    if (buf.readUInt32LE(i) === END) return i;
  }
  throw new Error("not a zip: no end record");
}

/**
 * A zip of these entries, each stored or deflated, laid out as a real writer
 * lays one out: what a sheet's tabs export as, and what a test of the reader
 * above makes. No zip64: an entry or an archive over 4 GB is not one KOS
 * writes.
 */
export function writeZip(entries: Record<string, string | Uint8Array>, { deflate = false, at = new Date() } = {}): Uint8Array {
  // When each entry was made, as DOS keeps it: local time, two-second steps, from 1980.
  const time = (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1);
  const date = ((Math.max(at.getFullYear(), 1980) - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, "utf8");
    const raw = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    const data = deflate ? deflateRawSync(raw) : raw;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    // Bit 11: the name is UTF-8, so a tab called "Dépenses" opens as itself.
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, dir, end]));
}
