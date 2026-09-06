import { describe, expect, it } from "vitest";

import { decodeAttributedBody } from "./attributedbody.js";
import { typedstream } from "./imessage.fixture.js";

describe("getting the words out of a message body", () => {
  it("reads a short body, whose length is one byte", () => {
    expect(decodeAttributedBody(typedstream("Sup"))).toBe("Sup");
  });

  it("reads a long body, whose length is a 16-bit count", () => {
    // Past 0x80 the count moves behind an 0x81 marker. Read as one byte, a
    // long message is truncated to its first few characters.
    const long = "x".repeat(450);
    expect(decodeAttributedBody(typedstream(long))).toBe(long);
  });

  it("keeps text that is not ascii", () => {
    const text = "café ☕ — done";
    expect(decodeAttributedBody(typedstream(text))).toBe(text);
  });

  it("says nothing rather than guessing at a shape it does not know", () => {
    expect(decodeAttributedBody(null)).toBeNull();
    expect(decodeAttributedBody(Buffer.alloc(0))).toBeNull();
    expect(decodeAttributedBody(Buffer.from("not a typedstream"))).toBeNull();
    // The class name with nothing after it.
    expect(decodeAttributedBody(Buffer.from("NSString"))).toBeNull();
  });

  it("refuses a length that runs past the end of the blob", () => {
    // A truncated row should read as no message, never as whatever bytes
    // happen to follow in memory.
    const blob = Buffer.concat([
      Buffer.from("NSString", "latin1"),
      Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b, 0x40]),
      Buffer.from("short", "utf8"),
    ]);
    expect(decodeAttributedBody(blob)).toBeNull();
  });
});
