import { describe, expect, it } from "vitest";

import { PICTURES } from "../files/images.fixture.js";
import { imageTypeOf } from "../files/images.js";
import { pdfOf } from "../files/pdf.fixture.js";
import { toPdf } from "../tools/pdf.js";
import { DOCUMENT_MAX_BYTES, FILE_MAX_BYTES, attachmentBlocks, isReadable, parseAttachments, readAttachments } from "./attachments.js";

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");
const MB = 1024 * 1024;

const utf8 = (data: string): string => Buffer.from(data, "base64").toString("utf8");

describe("readAttachments", () => {
  it("turns a PDF into the text file it reads as, and leaves the rest alone", async () => {
    // A PDF was refused as a type the model could not read; the owner's bills
    // and papers are PDFs.
    const pdf = toPdf([{ item: "kettle", price: "42" }], "Shopping").toString("base64");
    const picture = { name: "a.png", mediaType: "image/png", data: PICTURES["image/png"] };
    const out = await readAttachments([{ name: "bill.pdf", mediaType: "application/pdf", data: pdf }, picture, { name: "scan.PDF", mediaType: "", data: pdf }]);
    expect(out[1]).toEqual(picture);
    expect(out[0]).toMatchObject({ name: "bill.pdf", mediaType: "text/plain" });
    const text = Buffer.from(out[0]!.data, "base64").toString("utf8");
    expect(text.startsWith("[bill.pdf: 1 page]\n")).toBe(true);
    expect(text).toContain("kettle 42");
    expect(out[2]).toMatchObject({ name: "scan.PDF", mediaType: "text/plain" });
    expect(attachmentBlocks(out)[0]).toMatchObject({ type: "file", name: "bill.pdf" });
    expect(isReadable("application/pdf", "x.pdf")).toBe(true);
    expect(isReadable("application/zip", "x.zip")).toBe(false);
  });

  it("reads a PDF of 6 MB and one of 31 MB, under the providers' 32 MB", async () => {
    // Reported: a 6 MB PDF was refused against a blanket 5 MB.
    for (const size of [6 * MB, 31 * MB]) {
      const out = await readAttachments([{ name: "docs.pdf", mediaType: "application/pdf", data: pdfOf(size) }]);
      const text = Buffer.from(out[0]!.data, "base64").toString("utf8");
      expect(text).toContain("kettle 42");
      expect(attachmentBlocks(out)[0]).toMatchObject({ type: "file", name: "docs.pdf" });
    }
  });

  it("names a 60 MB PDF to the model where it was kept, with its pages, rather than reading it in", async () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({ item: `thing ${i}`, price: String(i) }));
    const [note] = await readAttachments([{ name: "manual.pdf", mediaType: "application/pdf", data: pdfOf(60 * MB, rows), path: "uploads/manual.pdf" }]);
    expect(note).toMatchObject({ name: "manual.pdf", mediaType: "text/plain", path: "uploads/manual.pdf" });
    expect(utf8(note!.data)).toMatch(
      /^\[manual\.pdf: a 60\.0 MB PDF of \d+ pages, kept at uploads\/manual\.pdf\. Too big to read in whole here \(a document is read in up to 32 MB.*\); read it from there with files\.read, some pages at a time \(from, to\)\.\]$/,
    );
    expect(utf8(note!.data)).not.toContain("thing 0");
    expect(DOCUMENT_MAX_BYTES).toBe(32 * MB);
  });

  it("refuses a PDF past 32 MB it could not keep, as there is nowhere to read it from", async () => {
    await expect(readAttachments([{ name: "docs.pdf", mediaType: "application/pdf", data: pdfOf(40 * MB) }])).rejects.toThrow(
      /docs\.pdf is 40\.0 MB; a document is read in up to 32 MB.*could not be kept in the workspace/,
    );
  });

  it("names a document that does not read, keeping the words and the rest", async () => {
    const bad = Buffer.from("not a pdf at all").toString("base64");
    const [note, rest] = await readAttachments([
      { name: "Invoice 1042.pdf", mediaType: "application/pdf", data: bad },
      { name: "notes.txt", mediaType: "text/plain", data: Buffer.from("hi").toString("base64") },
    ]);
    expect(utf8(note!.data)).toMatch(/^\[Invoice 1042\.pdf: could not be read: not a PDF/);
    expect(rest).toMatchObject({ name: "notes.txt" });
  });

  it("refuses a file of 120 MB, saying the limit and why", async () => {
    const data = Buffer.alloc(120 * MB).toString("base64");
    await expect(readAttachments([{ name: "video.mov", mediaType: "video/quicktime", data, path: "uploads/video.mov" }])).rejects.toThrow(
      /video\.mov is 120\.0 MB; a file can be up to 100 MB, the most KOS takes of one/,
    );
    expect(FILE_MAX_BYTES).toBe(100 * MB);
  });

  it("names a text file past 5 MB to the model where it was kept", async () => {
    const data = Buffer.alloc(6 * MB, 0x61).toString("base64");
    const [note] = await readAttachments([{ name: "server.log", mediaType: "text/plain", data, path: "uploads/server.log" }]);
    expect(utf8(note!.data)).toMatch(/^\[server\.log: a 6\.0 MB, kept at uploads\/server\.log\. .*with search\.grep, or files\.read a part at a time \(offset, limit\)\.\]$/);
  });
});

describe("pictures at the door", () => {
  it("sends an iPhone's HEIC as a JPEG, under the name it came with", async () => {
    // Reported: "HEIC not supported", for a photo straight off the owner's phone.
    const [photo] = await readAttachments([{ name: "IMG_0042.HEIC", mediaType: "image/heic", data: PICTURES["image/heic"], path: "uploads/IMG_0042.HEIC" }]);
    expect(photo).toMatchObject({ name: "IMG_0042.HEIC", mediaType: "image/jpeg", path: "uploads/IMG_0042.HEIC" });
    expect(imageTypeOf(Buffer.from(photo!.data, "base64"))).toBe("image/jpeg");
    expect(attachmentBlocks([photo!])[0]).toMatchObject({ type: "image", mediaType: "image/jpeg" });
  });

  it("goes by the bytes, not the name or the type claimed", async () => {
    // A .heic that is really a PNG is a PNG; a picture sent as text is a picture.
    const [fake, untyped] = await readAttachments([
      { name: "IMG_1.heic", mediaType: "image/heic", data: PICTURES["image/png"] },
      { name: "scan", mediaType: "application/octet-stream", data: PICTURES["image/tiff"] },
    ]);
    expect(fake).toEqual({ name: "IMG_1.heic", mediaType: "image/png", data: PICTURES["image/png"] });
    expect(untyped!.mediaType === "image/png" || untyped!.mediaType === "image/jpeg").toBe(true);
  });

  it("names a picture it cannot show to the model, keeping the words and the rest", async () => {
    // One bad picture used to refuse the whole message.
    const [bad, broken, notes] = await readAttachments([
      { name: "receipt.png", mediaType: "image/png", data: Buffer.from("not really a png").toString("base64"), path: "uploads/receipt.png" },
      { name: "IMG_2.HEIC", mediaType: "image/heic", data: PICTURES["image/heic"].slice(0, 200), path: "uploads/IMG_2.HEIC" },
      { name: "notes.txt", mediaType: "text/plain", data: b64("milk") },
    ]);
    expect(utf8(bad!.data)).toMatch(/^\[receipt\.png: kept at uploads\/receipt\.png, but not shown to the model: its bytes are not a picture KOS reads/);
    expect(attachmentBlocks([bad!])[0]).toMatchObject({ type: "file", name: "receipt.png" });
    expect(utf8(broken!.data)).toMatch(/^\[IMG_2\.HEIC: kept at uploads\/IMG_2\.HEIC, but not shown to the model: /);
    expect(notes).toEqual({ name: "notes.txt", mediaType: "text/plain", data: b64("milk") });
  });

  it("reads as text what its name says is text, whatever its first bytes look like", async () => {
    // "BM" opens a bitmap, and also a note about a car.
    const words = Buffer.concat([Buffer.from("BM"), Buffer.alloc(12), Buffer.from([40, 0, 0, 0]), Buffer.from(" service notes, all of them text")]).toString("base64");
    const [notes] = await readAttachments([{ name: "bmw.txt", mediaType: "", data: words }]);
    expect(notes).toMatchObject({ name: "bmw.txt", data: words });
  });

  it("reads an SVG as the text it is", async () => {
    const [svg] = await readAttachments([{ name: "icon.svg", mediaType: "image/svg+xml", data: Buffer.from("<svg/>").toString("base64") }]);
    expect(attachmentBlocks([svg!])[0]).toEqual({ type: "file", name: "icon.svg", text: "<svg/>" });
  });

  it("knows a picture by its name when a surface gives no type", () => {
    for (const name of ["IMG_1.HEIC", "a.heif", "b.avif", "c.tif", "d.bmp", "e.webp"]) expect(isReadable("", name)).toBe(true);
  });
});

describe("parseAttachments", () => {
  it("keeps well-formed entries", () => {
    expect(
      parseAttachments([{ name: "a.png", mediaType: "image/png", data: "AA" }]),
    ).toEqual([{ name: "a.png", mediaType: "image/png", data: "AA" }]);
  });

  it("drops entries with no name or no bytes", () => {
    expect(parseAttachments([{ name: "", data: "AA" }, { name: "b" }])).toEqual([]);
  });

  it("survives junk", () => {
    expect(parseAttachments("nope")).toEqual([]);
    expect(parseAttachments(null)).toEqual([]);
  });
});

describe("attachmentBlocks", () => {
  it("sends an image as bytes", () => {
    expect(
      attachmentBlocks([{ name: "a.png", mediaType: "image/png", data: "AAAA" }]),
    ).toEqual([
      { type: "image", name: "a.png", mediaType: "image/png", data: "AAAA" },
    ]);
  });

  it("keeps a text file as a file, with its name and contents", () => {
    // Flattened into text it stopped being an attachment: the reader saw a
    // wall of their own file quoted back in their own message.
    const blocks = attachmentBlocks([
      { name: "notes.md", mediaType: "text/markdown", data: b64("# Hi") },
    ]);
    expect(blocks[0]).toEqual({ type: "file", name: "notes.md", text: "# Hi" });
  });

  it("reads a text file the browser gave no type for", () => {
    // Browsers report an empty type for plenty of ordinary text files.
    const blocks = attachmentBlocks([
      { name: "data.csv", mediaType: "", data: b64("a,b") },
    ]);
    expect(blocks[0]).toMatchObject({ type: "file", name: "data.csv" });
  });

  it("refuses something the model cannot read, naming the file", () => {
    // Dropping it silently leaves the owner asking about a file the model was
    // never shown.
    expect(() =>
      attachmentBlocks([{ name: "a.zip", mediaType: "application/zip", data: "AA" }]),
    ).toThrow(/a\.zip .* cannot be read/);
  });

  it("refuses a picture past what a provider takes of one, should one get past the door", () => {
    const huge = "A".repeat(8 * 1024 * 1024);
    expect(() =>
      attachmentBlocks([{ name: "big.png", mediaType: "image/png", data: huge }]),
    ).toThrow(/big\.png is 6\.0 MB; a picture is sent to the model at up to 5 MB/);
  });
});

describe("file types the browser does not name", () => {
  it("reads a .tex file", () => {
    // Reported: main.tex came back as "unknown type" and was refused, which
    // is not something a reader can act on.
    const blocks = attachmentBlocks([
      { name: "main.tex", mediaType: "", data: b64("\\documentclass{article}") },
    ]);
    expect(blocks[0]).toMatchObject({ type: "file", name: "main.tex" });
    expect(JSON.stringify(blocks[0])).toContain("documentclass");
  });

  it("reads source files whatever the browser calls them", () => {
    for (const name of ["a.py", "b.rs", "c.go", "d.bib", "e.toml", "f.sql"]) {
      expect(
        attachmentBlocks([{ name, mediaType: "", data: b64("x") }])[0],
      ).toMatchObject({ type: "file", name });
    }
  });

  it("still refuses something genuinely unreadable", () => {
    expect(() =>
      attachmentBlocks([{ name: "a.zip", mediaType: "application/zip", data: "AA" }]),
    ).toThrow(/cannot be read/);
  });
});
