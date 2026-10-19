import { inflateRawSync } from "node:zlib";

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

/** The entries by name, each decompressed; a folder entry carries no bytes and is left out. */
export function readZip(bytes: Uint8Array): Map<string, Buffer> {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = endRecord(buf);
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
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
    if (name.endsWith("/")) continue;
    if (flags & 0x1) throw new Error(`${name} is encrypted`);
    if (size > ENTRY_MAX || compressed > ENTRY_MAX) continue;
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOCAL) throw new Error(`not a zip: ${name} has no local header`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + compressed);
    if (method === 0) out.set(name, Buffer.from(data));
    else if (method === 8) out.set(name, inflateRawSync(data, { maxOutputLength: ENTRY_MAX }));
    else throw new Error(`${name} is compressed a way this reader does not know (method ${method})`);
  }
  return out;
}

/** Where the end-of-central-directory record starts: scanned back from the end, past any comment. */
function endRecord(buf: Buffer): number {
  const floor = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= floor; i -= 1) {
    if (buf.readUInt32LE(i) === END) return i;
  }
  throw new Error("not a zip: no end record");
}
