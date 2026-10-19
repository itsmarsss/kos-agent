import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { isReadable, readAttachments } from "../kernel/attachments.js";
import { crc32 } from "./crc32.js";
import { isOffice, officeKindOf, officeNote, officeText } from "./office.js";
import { isZip, readZip } from "./zip.js";

/** A zip of these entries, each stored or deflated, the way a real writer lays one out. */
function zipOf(entries: Record<string, string>, { deflate = false } = {}): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, "utf8");
    const raw = Buffer.from(text, "utf8");
    const data = deflate ? deflateRawSync(raw) : raw;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
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

const DOCX = {
  "[Content_Types].xml": "<Types/>",
  "word/document.xml": [
    '<w:document><w:body>',
    "<w:p><w:r><w:t>Resume of </w:t></w:r><w:r><w:t>Kenny &amp; co</w:t></w:r></w:p>",
    "<w:p><w:r><w:t xml:space=\"preserve\">Skills:</w:t><w:tab/><w:t>TypeScript</w:t><w:br/><w:t>Rust</w:t></w:r></w:p>",
    "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Year</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Role</w:t></w:r></w:p></w:tc></w:tr>",
    "<w:tr><w:tc><w:p><w:r><w:t>2026</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Builder</w:t></w:r></w:p></w:tc></w:tr></w:tbl>",
    "<w:p/>",
    "</w:body></w:document>",
  ].join(""),
};

const XLSX = {
  "xl/workbook.xml": '<workbook><sheets><sheet name="Spend" sheetId="1" r:id="rId1"/><sheet name="Notes &amp; more" sheetId="2" r:id="rId2"/></sheets></workbook>',
  "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="x" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
  "xl/sharedStrings.xml": "<sst><si><t>Item</t></si><si><r><t>Ket</t></r><r><t>tle</t></r></si></sst>",
  "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Price</t></is></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>42</v></c><c r="C2" s="1"/><c r="D2" t="b"><v>1</v></c></row><row r="3"/></sheetData></worksheet>',
  "xl/worksheets/sheet2.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>later</t></is></c></row></sheetData></worksheet>',
};

const PPTX = {
  "ppt/presentation.xml": "<p:presentation/>",
  "ppt/slides/slide2.xml": "<p:sld><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:sld>",
  "ppt/slides/slide1.xml": "<p:sld><a:p><a:r><a:t>KOS</a:t></a:r><a:r><a:t> in a slide</a:t></a:r></a:p><a:p><a:r><a:t>Bullet one</a:t></a:r></a:p><a:p/></p:sld>",
  "ppt/slides/slide10.xml": "<p:sld><a:p><a:r><a:t>Tenth</a:t></a:r></a:p></p:sld>",
};

describe("a zip", () => {
  it("reads stored and deflated entries by name, and refuses what it is not", () => {
    const stored = readZip(zipOf({ "a.txt": "hello", "dir/": "", "dir/b.txt": "world" }));
    expect([...stored.keys()]).toEqual(["a.txt", "dir/b.txt"]);
    expect(stored.get("dir/b.txt")?.toString()).toBe("world");
    const deflated = readZip(zipOf({ "long.txt": "x".repeat(5000) }, { deflate: true }));
    expect(deflated.get("long.txt")?.length).toBe(5000);
    expect(isZip(zipOf({ "a": "b" }))).toBe(true);
    expect(isZip(new Uint8Array([1, 2, 3, 4, 5]))).toBe(false);
    expect(() => readZip(new Uint8Array(40))).toThrow(/not a zip/);
  });
});

describe("an Office document", () => {
  it("knows one by type or by name", () => {
    expect(officeKindOf("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "x")).toBe("docx");
    expect(officeKindOf("application/octet-stream", "Deck.PPTX")).toBe("pptx");
    expect(officeKindOf("", "ledger.xlsx")).toBe("xlsx");
    expect(officeKindOf("application/pdf", "a.pdf")).toBeUndefined();
    expect(isOffice(zipOf(DOCX), "cv.docx")).toBe(true);
    expect(isOffice(new Uint8Array([1, 2, 3, 4, 5]), "cv.docx")).toBe(false);
  });

  it("reads a Word document as its paragraphs, a table row as one line", () => {
    const read = officeText(zipOf(DOCX), "cv.docx");
    expect(read).toMatchObject({ kind: "docx", parts: 4, truncated: false });
    expect(read.text).toBe("Resume of Kenny & co\n\nSkills:\tTypeScript\nRust\n\nYear | Role\n\n2026 | Builder");
    expect(officeNote(read)).toBe("docx, 4 paragraphs");
    // With no name or type to go by, what is inside says what it is.
    expect(officeText(zipOf(DOCX, { deflate: true })).kind).toBe("docx");
  });

  it("reads a workbook sheet by sheet, shared and inline strings, numbers and booleans", () => {
    const read = officeText(zipOf(XLSX), "spend.xlsx");
    expect(read).toMatchObject({ kind: "xlsx", parts: 3 });
    expect(read.text).toBe("--- sheet Spend ---\nItem | Price\nKettle | 42 | TRUE\n\n--- sheet Notes & more ---\nlater");
    expect(officeNote(read)).toBe("xlsx, 3 rows");
  });

  it("reads a deck slide by slide, in slide order", () => {
    const read = officeText(zipOf(PPTX), "deck.pptx");
    expect(read).toMatchObject({ kind: "pptx", parts: 3 });
    expect(read.text).toBe("--- slide 1 of 3 ---\nKOS in a slide\nBullet one\n\n--- slide 2 of 3 ---\nSecond\n\n--- slide 3 of 3 ---\nTenth");
  });

  it("stops at the cap and says so", () => {
    const read = officeText(zipOf(DOCX), "cv.docx", "", 25);
    expect(read.truncated).toBe(true);
    expect(read.text.length).toBeLessThanOrEqual(25);
    expect(officeNote(read)).toContain("cut at the cap");
  });

  it("comes through the door as the text file it reads as, like a PDF", async () => {
    expect(isReadable("", "cv.docx")).toBe(true);
    expect(isReadable("application/zip", "cv.zip")).toBe(false);
    const [file] = await readAttachments([{ name: "cv.docx", mediaType: "application/octet-stream", data: Buffer.from(zipOf(DOCX)).toString("base64") }]);
    expect(file).toMatchObject({ name: "cv.docx", mediaType: "text/plain" });
    expect(Buffer.from(file!.data, "base64").toString("utf8")).toBe("[cv.docx: docx, 4 paragraphs]\nResume of Kenny & co\n\nSkills:\tTypeScript\nRust\n\nYear | Role\n\n2026 | Builder");
  });

  it("refuses a zip that is not a document", () => {
    expect(() => officeText(zipOf({ "a.txt": "x" }), "a.zip")).toThrow(/not an Office document/);
  });
});
