/**
 * Getting the words out of a message.
 *
 * `message.text` is the obvious column and it is almost always empty: on a
 * real database, 111 of 112 messages in a thread had it NULL. Modern Messages
 * stores the body in `attributedBody` instead, an NSAttributedString written
 * in Apple's typedstream format, and a reader that trusts `text` sees almost
 * nothing while appearing to work.
 *
 * This is not a general typedstream parser and does not try to be. The body
 * is the first NSString in the archive, and the shape around it is fixed:
 *
 *   ... NSString \x01 \x94 \x84 \x01 + <length> <utf8 bytes> ...
 *
 * where `+` marks a byte array and <length> is one byte below 0x80, or 0x81
 * followed by a 16-bit little-endian count, or 0x82 followed by a 32-bit one.
 * Anything unexpected returns null, so the caller falls back to `text` rather
 * than delivering a mangled message.
 */

const STRING_MARKER = 0x2b;
const LENGTH_16 = 0x81;
const LENGTH_32 = 0x82;

export function decodeAttributedBody(blob: Buffer | null | undefined): string | null {
  if (!blob || blob.length === 0) return null;

  const classIndex = blob.indexOf("NSString", 0, "latin1");
  if (classIndex === -1) return null;

  const marker = blob.indexOf(STRING_MARKER, classIndex);
  // The marker sits within a few bytes of the class name. Further away than
  // that and this is a layout we do not understand.
  if (marker === -1 || marker - classIndex > 16) return null;

  let cursor = marker + 1;
  if (cursor >= blob.length) return null;

  let length = blob[cursor]!;
  cursor += 1;
  if (length === LENGTH_16) {
    if (cursor + 2 > blob.length) return null;
    length = blob.readUInt16LE(cursor);
    cursor += 2;
  } else if (length === LENGTH_32) {
    if (cursor + 4 > blob.length) return null;
    length = blob.readUInt32LE(cursor);
    cursor += 4;
  } else if (length >= 0x80) {
    // Some other continuation byte: not a shape this understands.
    return null;
  }

  if (length === 0 || cursor + length > blob.length) return null;
  const text = blob.subarray(cursor, cursor + length).toString("utf8");
  // A body that decoded to replacement characters is a wrong guess at the
  // layout, not a message. Better to say nothing than to deliver noise.
  return text.includes("�") ? null : text;
}
