import { PDF_TEXT_MAX } from "./pdftext.js";
import { isZip, readZip } from "./zip.js";

/**
 * The words in an Office document.
 *
 * A .docx, .xlsx or .pptx is a zip of XML, and the words in it sit in a
 * handful of tags: a paragraph's runs, a sheet's cells, a slide's text
 * boxes. This reads those and nothing else, the way the PDF reader reads
 * text and not scripts, with the same cap. No library: the three formats
 * share one zip reader and a few lines of tag picking each.
 */

export type OfficeKind = "docx" | "xlsx" | "pptx";

export interface OfficeText {
  text: string;
  kind: OfficeKind;
  /** Paragraphs, rows or slides read. */
  parts: number;
  /** True when the cap cut the text short. */
  truncated: boolean;
}

const BY_EXTENSION: Record<string, OfficeKind> = { ".docx": "docx", ".xlsx": "xlsx", ".pptx": "pptx" };
const BY_TYPE: Record<string, OfficeKind> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};
/** Rows a sheet gives up after; a ledger past this is a table to query, not a page to read. */
const ROWS_MAX = 5000;

/** The kind an Office file is, by its type or its name; nothing for anything else. */
export function officeKindOf(mediaType: string, name: string): OfficeKind | undefined {
  const byType = BY_TYPE[mediaType.split(";")[0]?.trim().toLowerCase() ?? ""];
  if (byType) return byType;
  const ext = /\.[A-Za-z0-9]+$/.exec(name)?.[0]?.toLowerCase() ?? "";
  return BY_EXTENSION[ext];
}

/** An Office document by name or type, and a zip by its bytes. */
export function isOffice(bytes: Uint8Array, name: string, mediaType = ""): boolean {
  return officeKindOf(mediaType, name) !== undefined && isZip(bytes);
}

/** The kind by what the zip holds, for a file whose name and type say nothing. */
function kindInside(entries: Map<string, Buffer>): OfficeKind | undefined {
  if (entries.has("word/document.xml")) return "docx";
  if (entries.has("xl/workbook.xml")) return "xlsx";
  if (entries.has("ppt/presentation.xml")) return "pptx";
  return undefined;
}

/** What was read, for a head line: "docx, 12 paragraphs". */
export function officeNote(read: OfficeText): string {
  const unit = read.kind === "docx" ? "paragraph" : read.kind === "xlsx" ? "row" : "slide";
  return `${read.kind}, ${read.parts} ${unit}${read.parts === 1 ? "" : "s"}${read.truncated ? ", cut at the cap" : ""}`;
}

/** The document's text, in reading order, under the cap. */
export function officeText(bytes: Uint8Array, name = "", mediaType = "", maxChars = PDF_TEXT_MAX): OfficeText {
  if (!isZip(bytes)) throw new Error("not an Office document: the file is not a zip");
  const entries = readZip(bytes);
  const kind = officeKindOf(mediaType, name) ?? kindInside(entries);
  if (!kind) throw new Error("not an Office document: no document, workbook or presentation inside");
  const blocks = kind === "docx" ? docxBlocks(entries) : kind === "xlsx" ? xlsxBlocks(entries) : pptxBlocks(entries);
  let length = 0;
  let truncated = false;
  const kept: string[] = [];
  for (const block of blocks.text) {
    if (length + block.length > maxChars) {
      kept.push(block.slice(0, Math.max(0, maxChars - length)));
      truncated = true;
      break;
    }
    kept.push(block);
    length += block.length + 2;
  }
  return { text: kept.join("\n\n").trim(), kind, parts: blocks.parts, truncated };
}

/** XML's five entities and numeric references, back to characters. */
function decode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (whole, ref: string) => {
    if (ref.startsWith("#x")) return String.fromCodePoint(parseInt(ref.slice(2), 16));
    if (ref.startsWith("#")) return String.fromCodePoint(Number(ref.slice(1)));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[ref] ?? whole;
  });
}

/** The text inside every `<tag>` in a piece of XML, in order. */
function texts(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, "g");
  const out: string[] = [];
  for (const m of xml.matchAll(re)) out.push(decode(m[1] ?? ""));
  return out;
}

/** Every `<tag>…</tag>` block, in order. */
function blocksOf(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  return [...xml.matchAll(re)].map((m) => m[1] ?? "");
}

function xmlOf(entries: Map<string, Buffer>, name: string): string {
  return entries.get(name)?.toString("utf8") ?? "";
}

/** A Word document: its paragraphs, a table row as one line with its cells apart. */
function docxBlocks(entries: Map<string, Buffer>): { text: string[]; parts: number } {
  let body = xmlOf(entries, "word/document.xml");
  // A tab and a break are text too; a row's cells become one paragraph.
  body = body.replace(/<w:tab\/>/g, "<w:t>\t</w:t>").replace(/<w:br\/>/g, "<w:t>\n</w:t>");
  body = body.replace(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g, (row) => {
    const cells = blocksOf(row, "w:tc").map((cell) => blocksOf(cell, "w:p").map((p) => texts(p, "w:t").join("")).join(" ").trim());
    return `<w:p><w:t>${cells.join(" | ").replace(/&/g, "&amp;").replace(/</g, "&lt;")}</w:t></w:p>`;
  });
  const paragraphs = blocksOf(body, "w:p")
    .map((p) => texts(p, "w:t").join("").trim())
    .filter((p) => p !== "");
  return { text: paragraphs, parts: paragraphs.length };
}

/** A workbook: each sheet under its name, a row per line, cells apart. */
function xlsxBlocks(entries: Map<string, Buffer>): { text: string[]; parts: number } {
  const shared = blocksOf(xmlOf(entries, "xl/sharedStrings.xml"), "si").map((si) => texts(si, "t").join(""));
  const rels = new Map<string, string>();
  for (const m of xmlOf(entries, "xl/_rels/workbook.xml.rels").matchAll(/<Relationship\s[^>]*>/g)) {
    const id = /\sId="([^"]*)"/.exec(m[0])?.[1];
    const target = /\sTarget="([^"]*)"/.exec(m[0])?.[1];
    if (id && target) rels.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  }
  const sheets: { name: string; path: string }[] = [];
  for (const m of xmlOf(entries, "xl/workbook.xml").matchAll(/<sheet\s[^>]*>/g)) {
    const name = decode(/\sname="([^"]*)"/.exec(m[0])?.[1] ?? "Sheet");
    const id = /\sr:id="([^"]*)"/.exec(m[0])?.[1] ?? "";
    const path = rels.get(id);
    if (path && entries.has(path)) sheets.push({ name, path });
  }
  const text: string[] = [];
  let rows = 0;
  for (const sheet of sheets) {
    const lines: string[] = [];
    for (const row of blocksOf(xmlOf(entries, sheet.path), "row")) {
      if (lines.length >= ROWS_MAX) break;
      const cells: string[] = [];
      for (const m of row.matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = m[1] ?? "";
        const inner = m[2] ?? "";
        const type = /\st="([^"]*)"/.exec(attrs)?.[1];
        const value = /<v>([^<]*)<\/v>/.exec(inner)?.[1];
        let cell = "";
        if (type === "s") cell = shared[Number(value)] ?? "";
        else if (type === "inlineStr") cell = texts(inner, "t").join("");
        else if (type === "b") cell = value === "1" ? "TRUE" : "FALSE";
        else cell = decode(value ?? "");
        if (cell !== "") cells.push(cell);
      }
      if (cells.length) lines.push(cells.join(" | "));
    }
    rows += lines.length;
    if (lines.length) text.push(`${sheets.length > 1 ? `--- sheet ${sheet.name} ---\n` : ""}${lines.join("\n")}`);
  }
  return { text, parts: rows };
}

/** A deck: each slide's lines under a marker, in slide order. */
function pptxBlocks(entries: Map<string, Buffer>): { text: string[]; parts: number } {
  const slides = [...entries.keys()]
    .map((name) => ({ name, n: Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(name)?.[1] ?? NaN) }))
    .filter((s) => !Number.isNaN(s.n))
    .sort((a, b) => a.n - b.n);
  const text: string[] = [];
  for (const [i, slide] of slides.entries()) {
    const lines = blocksOf(xmlOf(entries, slide.name), "a:p")
      .map((p) => texts(p, "a:t").join("").trim())
      .filter((line) => line !== "");
    text.push(`${slides.length > 1 ? `--- slide ${i + 1} of ${slides.length} ---\n` : ""}${lines.join("\n")}`);
  }
  return { text, parts: slides.length };
}
