import { describe, expect, it } from "vitest";

import { ATTACH_FILE_BYTES, ATTACH_FILES, ATTACH_KEPT_MS, ATTACH_PART_CHARS, AttachmentInbox } from "./inbox.js";

/**
 * Files a device sends in parts ahead of the words they go with: whole ones
 * go with the words, and one that is not whole, too big or unreadable stops
 * them with why.
 */

const png = Buffer.from("a picture of a receipt, as bytes").toString("base64");

/** A file sent as parts of `size` characters, as a device sends it. */
function send(inbox: AttachmentInbox, id: string, data: string, name = "receipt.png", mediaType = "image/png", size = ATTACH_PART_CHARS): void {
  const parts = Math.max(1, Math.ceil(data.length / size));
  for (let part = 0; part < parts; part++) inbox.part("dev_phone", { id, name, mediaType, part, parts, data: data.slice(part * size, (part + 1) * size) });
}

describe("the attachment inbox", () => {
  it("puts a file sent in parts back together for the words that name it, once", () => {
    const inbox = new AttachmentInbox();
    send(inbox, "f1", png, "receipt.png", "image/png", 8);
    expect(inbox.take("dev_phone", ["f1"])).toEqual({ files: [{ name: "receipt.png", mediaType: "image/png", data: png }] });
    expect(inbox.take("dev_phone", ["f1"])).toEqual({ refused: "A file did not arrive whole. Attach it again." });
  });

  it("takes nothing for words with no files, and holds each device's apart", () => {
    const inbox = new AttachmentInbox();
    send(inbox, "f1", png);
    expect(inbox.take("dev_phone", undefined)).toEqual({ files: [] });
    expect(inbox.take("dev_other", ["f1"])).toEqual({ refused: "A file did not arrive whole. Attach it again." });
  });

  it("refuses a file with a part missing", () => {
    const inbox = new AttachmentInbox();
    inbox.part("dev_phone", { id: "f1", name: "a.png", mediaType: "image/png", part: 0, parts: 2, data: "AAAA" });
    expect(inbox.take("dev_phone", ["f1"])).toEqual({ refused: "a.png did not arrive whole. Attach it again." });
  });

  it("refuses a part sent twice, out of range, too long or not base64", () => {
    for (const bad of [
      [{ part: 0, data: "AAAA" }, { part: 0, data: "AAAA" }],
      [{ part: 2, data: "AAAA" }],
      [{ part: 0, data: "A".repeat(ATTACH_PART_CHARS + 4) }],
      [{ part: 0, data: "not base64!" }],
      // Only the last part may be padded: one padded before it would not join.
      [{ part: 0, data: "AA==" }, { part: 1, data: "AAAA" }],
    ]) {
      const inbox = new AttachmentInbox();
      for (const p of bad) inbox.part("dev_phone", { id: "f1", name: "a.png", mediaType: "image/png", parts: 2, ...p });
      expect(inbox.take("dev_phone", ["f1"])).toEqual({ refused: "a.png did not arrive whole. Attach it again." });
    }
  });

  it("refuses a file past the model's limit, and one KOS cannot read", () => {
    const inbox = new AttachmentInbox();
    const parts = Math.ceil((ATTACH_FILE_BYTES * 4) / 3 / ATTACH_PART_CHARS) + 1;
    inbox.part("dev_phone", { id: "big", name: "big.png", mediaType: "image/png", part: 0, parts, data: "AAAA" });
    inbox.part("dev_phone", { id: "zip", name: "photos.zip", mediaType: "application/zip", part: 0, parts: 1, data: "AAAA" });
    expect(inbox.take("dev_phone", ["big"])).toEqual({ refused: "big.png is more than KOS takes: files go up to 5 MB." });
    expect(inbox.take("dev_phone", ["zip"])).toEqual({ refused: "KOS cannot read photos.zip: send a picture, a PDF, an Office file or a text file." });
  });

  it("goes by bytes as well as parts: a file whose parts add up past the limit is refused", () => {
    const inbox = new AttachmentInbox();
    const full = "A".repeat(ATTACH_PART_CHARS);
    const parts = Math.ceil((ATTACH_FILE_BYTES * 4) / 3 / ATTACH_PART_CHARS);
    for (let part = 0; part < parts; part++) inbox.part("dev_phone", { id: "f1", name: "scan.pdf", mediaType: "application/pdf", part, parts, data: full });
    expect(inbox.take("dev_phone", ["f1"])).toEqual({ refused: "scan.pdf is more than KOS takes: files go up to 5 MB." });
  });

  it("holds a few files at once, and sends at most that many with one message", () => {
    const inbox = new AttachmentInbox();
    for (let i = 0; i <= ATTACH_FILES; i++) send(inbox, `f${i}`, png);
    expect(inbox.take("dev_phone", Array.from({ length: ATTACH_FILES + 1 }, (_, i) => `f${i}`))).toEqual({ refused: `At most ${ATTACH_FILES} files go with one message.` });
    // The one past the hold was never kept.
    expect(inbox.take("dev_phone", [`f${ATTACH_FILES}`])).toEqual({ refused: "A file did not arrive whole. Attach it again." });
    expect(inbox.take("dev_phone", ["f0", "f1"])).toMatchObject({ files: [{ name: "receipt.png" }, { name: "receipt.png" }] });
  });

  it("drops a file that waited too long for its words", () => {
    let now = 0;
    const inbox = new AttachmentInbox(() => now);
    send(inbox, "f1", png);
    now = ATTACH_KEPT_MS + 1;
    expect(inbox.take("dev_phone", ["f1"])).toEqual({ refused: "A file did not arrive whole. Attach it again." });
  });

  it("refuses files named in a way it does not read, and keeps a name to one line", () => {
    const inbox = new AttachmentInbox();
    expect(inbox.take("dev_phone", "f1")).toEqual({ refused: "The files with that message were not named right. Attach them again." });
    send(inbox, "f1", png, "../../etc/receipt\n.png");
    expect(inbox.take("dev_phone", ["f1"])).toMatchObject({ files: [{ name: ".. .. etc receipt .png" }] });
  });
});
