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

  it("refuses an attachment past the size limit", () => {
    const huge = "A".repeat(8 * 1024 * 1024);
    expect(() =>
      attachmentBlocks([{ name: "big.png", mediaType: "image/png", data: huge }]),
    ).toThrow(/limit is 5MB/);
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
