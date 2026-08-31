import { describe, expect, it } from "vitest";

import { attachmentBlocks, parseAttachments } from "./attachments.js";

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

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
    ).toEqual([{ type: "image", mediaType: "image/png", data: "AAAA" }]);
  });

  it("inlines a text file with its name", () => {
    const blocks = attachmentBlocks([
      { name: "notes.md", mediaType: "text/markdown", data: b64("# Hi") },
    ]);
    expect(blocks[0]).toEqual({
      type: "text",
      text: "Attached file notes.md:\n\n# Hi",
    });
  });

  it("reads a text file the browser gave no type for", () => {
    // Browsers report an empty type for plenty of ordinary text files.
    const blocks = attachmentBlocks([
      { name: "data.csv", mediaType: "", data: b64("a,b") },
    ]);
    expect(blocks[0]).toMatchObject({ type: "text" });
  });

  it("refuses something the model cannot read, naming the file", () => {
    // Dropping it silently leaves the owner asking about a file the model was
    // never shown.
    expect(() =>
      attachmentBlocks([{ name: "a.zip", mediaType: "application/zip", data: "AA" }]),
    ).toThrow(/a\.zip .* cannot be read/);
  });

  it("refuses an attachment past the size limit", () => {
    const huge = "A".repeat(8 * 1024 * 1024);
    expect(() =>
      attachmentBlocks([{ name: "big.png", mediaType: "image/png", data: huge }]),
    ).toThrow(/limit is 5MB/);
  });
});
