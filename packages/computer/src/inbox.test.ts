import { describe, expect, it } from "vitest";

import { ATTACH_FILE_BYTES, ATTACH_FILES, ATTACH_HELD_CHARS, AttachmentBudget, ATTACH_KEPT_MS, ATTACH_PART_CHARS, AttachmentInbox } from "./inbox.js";

/**
 * Files a device sends in parts ahead of the words they go with: whole ones
 * go with the words, and one that is not whole, too big or unreadable stops
 * them with why.
 */

/** A PNG's signature and a little after it: what the inbox reads a picture by. */
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("a picture of a receipt")]).toString("base64");

/** An iPhone photo's head and a TIFF's: what the inbox reads them by. */
const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic\0\0\0\0mif1heic", "latin1"), Buffer.alloc(32)]).toString("base64");
const tiff = Buffer.concat([Buffer.from("II*\0", "latin1"), Buffer.alloc(32)]).toString("base64");

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
    expect(inbox.take("dev_phone", ["big"])).toEqual({ refused: "big.png is more than KOS takes: files go up to 100 MB." });
    expect(inbox.take("dev_phone", ["zip"])).toEqual({ refused: "KOS cannot read photos.zip: send a picture, a PDF, an Office file or a text file." });
  });

  it("takes a file sent again from its first part, as after a dropped line", () => {
    const inbox = new AttachmentInbox();
    inbox.part("dev_phone", { id: "f1", name: "receipt.png", mediaType: "image/png", part: 0, parts: 1, data: png });
    send(inbox, "f1", png, "receipt.png", "image/png", 8);
    expect(inbox.take("dev_phone", ["f1"])).toMatchObject({ files: [{ data: png }] });
  });

  it("refuses a file of exactly the model's limit, as the model's path measures it", () => {
    const inbox = new AttachmentInbox();
    const exact = Buffer.alloc(ATTACH_FILE_BYTES, 0x41).toString("base64");
    send(inbox, "f1", exact, "notes.txt", "text/plain");
    expect(inbox.take("dev_phone", ["f1"])).toEqual({ refused: "notes.txt is more than KOS takes: files go up to 100 MB." });
  });

  it("takes only what a file is by its bytes: pictures a model reads, PDFs, Office files and text", () => {
    const pdf = Buffer.from("%PDF-1.7\n").toString("base64");
    const docx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2]).toString("base64");
    const cases: [string, string, string, string | undefined][] = [
      ["lease.pdf", "application/pdf", pdf, undefined],
      ["plan.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", docx, undefined],
      ["notes.txt", "text/plain", Buffer.from("milk, eggs").toString("base64"), undefined],
      ["fake.png", "image/png", Buffer.from("<svg onload=x>").toString("base64"), "fake.png is not the picture it says it is."],
      ["fake.pdf", "application/pdf", png, "fake.pdf is not the PDF it says it is."],
      ["fake.txt", "text/plain", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1]).toString("base64"), "fake.txt is not the text file it says it is."],
      ["icon.svg", "image/svg+xml", Buffer.from("<svg/>").toString("base64"), "KOS takes pictures as JPEG, PNG, GIF, WebP, HEIC, HEIF, AVIF, TIFF or BMP, so icon.svg cannot go."],
      ["IMG_0042.HEIC", "image/heic", heic, undefined],
      ["scan.tiff", "image/tiff", tiff, undefined],
      // A HEIC that is really a PNG goes, to be read as the PNG it is.
      ["IMG_1.heic", "image/heic", png, undefined],
      ["fake.heic", "image/heic", Buffer.from("not a photo at all").toString("base64"), "fake.heic is not the picture it says it is."],
    ];
    for (const [name, mediaType, data, refused] of cases) {
      const inbox = new AttachmentInbox();
      send(inbox, "f1", data, name, mediaType);
      expect(inbox.take("dev_phone", ["f1"])).toEqual(refused ? { refused } : { files: [{ name, mediaType, data }] });
    }
  });

  it("holds files for every panel's devices within one budget, and refuses past it", () => {
    // Room for two parts: two inboxes, as two panels have, share it.
    const budget = new AttachmentBudget(2 * ATTACH_PART_CHARS);
    const phone = new AttachmentInbox(Date.now, budget);
    const mac = new AttachmentInbox(Date.now, budget);
    phone.part("dev_a", { id: "f1", name: "scan.pdf", mediaType: "application/pdf", part: 0, parts: 1, data: "JVBERi0x" });
    mac.part("dev_b", { id: "f1", name: "scan.pdf", mediaType: "application/pdf", part: 0, parts: 1, data: "JVBERi0x" });
    mac.part("dev_b", { id: "f2", name: "notes.txt", mediaType: "text/plain", part: 0, parts: 1, data: "bWlsaw==" });
    expect(mac.take("dev_b", ["f2"])).toEqual({ refused: "KOS is holding as many files as it can now. Attach notes.txt again in a moment." });
    // A file sent again from its first part is checked again, and what it replaces does not count against it.
    phone.part("dev_a", { id: "f1", name: "scan.pdf", mediaType: "application/pdf", part: 0, parts: 2, data: "JVBERi0x" });
    expect(phone.take("dev_a", ["f1"])).toEqual({ refused: "KOS is holding as many files as it can now. Attach scan.pdf again in a moment." });
    // Taken, a file frees its room.
    expect(mac.take("dev_b", ["f1"])).toMatchObject({ files: [{ name: "scan.pdf" }] });
    mac.part("dev_b", { id: "f3", name: "notes.txt", mediaType: "text/plain", part: 0, parts: 1, data: "bWlsaw==" });
    expect(mac.take("dev_b", ["f3"])).toMatchObject({ files: [{ name: "notes.txt" }] });
  });

  it("holds a message of four of the largest files whole", () => {
    expect(ATTACH_HELD_CHARS).toBeLessThan(600 * 1024 * 1024);
    const inbox = new AttachmentInbox(Date.now, new AttachmentBudget());
    const parts = Math.ceil((ATTACH_FILE_BYTES * 4) / 3 / ATTACH_PART_CHARS);
    for (let i = 0; i < ATTACH_FILES; i++) inbox.part("dev_phone", { id: `f${i}`, name: "scan.pdf", mediaType: "application/pdf", part: 0, parts, data: "JVBERi0x" });
    // Each began without refusal: the one part it brought is in place, the rest awaited.
    for (let i = 0; i < ATTACH_FILES; i++) expect(inbox.take("dev_phone", [`f${i}`])).toEqual({ refused: "scan.pdf did not arrive whole. Attach it again." });
  });

  it("keeps nothing for a device that is no longer on its line", () => {
    const inbox = new AttachmentInbox();
    send(inbox, "f1", png);
    inbox.keepOnly(new Set(["dev_other"]));
    expect(inbox.take("dev_phone", ["f1"])).toEqual({ refused: "A file did not arrive whole. Attach it again." });
  });

  it("goes by bytes as well as parts: a file whose parts add up past the limit is refused", () => {
    const inbox = new AttachmentInbox();
    const full = "A".repeat(ATTACH_PART_CHARS);
    const parts = Math.ceil((ATTACH_FILE_BYTES * 4) / 3 / ATTACH_PART_CHARS);
    for (let part = 0; part < parts; part++) inbox.part("dev_phone", { id: "f1", name: "scan.pdf", mediaType: "application/pdf", part, parts, data: full });
    expect(inbox.take("dev_phone", ["f1"])).toEqual({ refused: "scan.pdf is more than KOS takes: files go up to 100 MB." });
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
