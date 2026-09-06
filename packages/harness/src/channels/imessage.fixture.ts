/**
 * Message bodies in the shape Messages actually writes them.
 *
 * Test-only, and kept out of the test files so that importing it from one
 * does not drag another suite's cases in with it.
 */

/** A body in the typedstream shape Messages actually writes. */
export function typedstream(text: string): Buffer {
  const body = Buffer.from(text, "utf8");
  const length =
    body.length < 0x80
      ? Buffer.from([body.length])
      : Buffer.concat([
          Buffer.from([0x81]),
          (() => {
            const b = Buffer.alloc(2);
            b.writeUInt16LE(body.length);
            return b;
          })(),
        ]);
  return Buffer.concat([
    Buffer.from("\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84", "latin1"),
    Buffer.from("NSString", "latin1"),
    Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]),
    length,
    body,
    Buffer.from([0x86]),
  ]);
}
