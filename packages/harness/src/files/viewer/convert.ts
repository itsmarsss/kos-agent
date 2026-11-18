import { isZip, readZip, ZipTooLarge } from "../zip.js";
import { docxToView } from "./docx.js";
import type { OfficeView, ViewFormat } from "@kos/shared";
import { pptxToView } from "./pptx.js";
import { sanitizeHtml } from "./sanitize.js";
import { delimitedToView, workbookToView } from "./sheets.js";

/**
 * One file to one view, by its format. Run inside the viewer's worker
 * (worker.ts), so a file that parses forever or allocates without end is
 * ended there; nothing here touches the disk or the network.
 */

/** The formats by extension, the variants (macro-enabled, templates) read as their kind: their macros are never opened. */
const BY_EXTENSION: Record<string, ViewFormat> = {
  docx: "docx", docm: "docx", dotx: "docx", dotm: "docx",
  doc: "doc", dot: "doc", rtf: "rtf", odt: "odt", pages: "pages",
  xlsx: "xlsx", xlsm: "xlsx", xltx: "xlsx", xltm: "xlsx", xlsb: "xlsx", xls: "xls", ods: "ods",
  csv: "csv", tsv: "tsv", numbers: "numbers",
  pptx: "pptx", pptm: "pptx", potx: "pptx", ppsx: "pptx", ppt: "ppt", pps: "ppt", odp: "odp", key: "key",
};

export function viewFormatOf(name: string): ViewFormat | undefined {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? BY_EXTENSION[name.slice(dot + 1).toLowerCase()] : undefined;
}

/** Formats read by macOS's textutil, where the host has it. */
export const TEXTUTIL_FORMATS = new Set<ViewFormat>(["doc", "rtf", "odt"]);
/** Formats shown as a picture of their first page or slide, where the host can draw one. */
export const PICTURE_FORMATS = new Set<ViewFormat>(["ppt", "odp"]);

/** What a zip-based file may inflate to, all told: a large deck's pictures, not a bomb's gigabytes. */
export const ZIP_TOTAL_MAX = 160 * 1024 * 1024;
const ZIP_ENTRY_MAX = 64 * 1024 * 1024;

export type ConvertRequest = { op: "convert"; bytes: Uint8Array; format: ViewFormat } | { op: "sanitize"; html: string; format: ViewFormat };

export function runRequest(req: ConvertRequest): OfficeView {
  if (req.op === "sanitize") return { kind: "doc", format: req.format, html: sanitizeHtml(req.html), notes: [] };
  return convert(req.bytes, req.format);
}

/** The container each format comes in: its bytes are sniffed and must agree with its name. */
const CONTAINER: Partial<Record<ViewFormat, "zip" | "ole" | "text">> = {
  docx: "zip", xlsx: "zip", ods: "zip", numbers: "zip", pptx: "zip", pages: "zip", key: "zip",
  xls: "ole", csv: "text", tsv: "text",
};
/** The part inside a zip that says which format it is. */
const INSIDE: Partial<Record<ViewFormat, (parts: Map<string, Buffer>) => boolean>> = {
  docx: (p) => p.has("word/document.xml"),
  xlsx: (p) => p.has("xl/workbook.xml") || p.has("xl/workbook.bin"),
  pptx: (p) => p.has("ppt/presentation.xml"),
  ods: (p) => p.get("mimetype")?.toString("latin1").trim() === "application/vnd.oasis.opendocument.spreadsheet",
  numbers: (p) => [...p.keys()].some((k) => k.startsWith("Index/")),
  pages: (p) => [...p.keys()].some((k) => k.startsWith("Index/") || k.startsWith("preview")),
  key: (p) => [...p.keys()].some((k) => k.startsWith("Index/") || k.startsWith("preview")),
};
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const CONTAINER_WORDS = { zip: "a zip archive", ole: "an Office 97 file", text: "text" } as const;

function containerOf(bytes: Uint8Array): "zip" | "ole" | "text" {
  if (isZip(bytes)) return "zip";
  if (OLE.every((b, i) => bytes[i] === b)) return "ole";
  return "text";
}

export function convert(bytes: Uint8Array, format: ViewFormat): OfficeView {
  const got = containerOf(bytes);
  // A zip is inflated under the caps before anything else reads it, whatever its name says:
  // SheetJS reads by content, and its own inflater is not bounded.
  const parts = got === "zip" ? zipParts(bytes) : undefined;
  const want = CONTAINER[format];
  if (!want) throw new Error(`a ${format} file is not read here`);
  const mismatch = (): Error => new Error(`refused: the file is not what its name says (a .${format} file holding ${CONTAINER_WORDS[got]})`);
  if (want !== got) throw mismatch();
  if (parts && INSIDE[format] && !INSIDE[format](parts)) throw mismatch();
  switch (format) {
    case "csv":
    case "tsv":
      return delimitedToView(new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, ""), format);
    case "xls":
    case "xlsx":
    case "ods":
      return workbookToView(bytes, format);
    case "numbers":
      try {
        return workbookToView(bytes, format);
      } catch {
        return iworkPreview(parts!, format);
      }
    case "docx": {
      const view = docxToView(parts!);
      return { ...view, html: sanitizeHtml(view.html) };
    }
    case "pptx":
      return pptxToView(parts!);
    default:
      return iworkPreview(parts!, format);
  }
}

/** The archive's parts, every one inflated under the caps; a bomb is refused, not followed. */
function zipParts(bytes: Uint8Array): Map<string, Buffer> {
  try {
    return readZip(bytes, { entryMax: ZIP_ENTRY_MAX, totalMax: ZIP_TOTAL_MAX, oversize: "refuse" });
  } catch (err) {
    if (err instanceof ZipTooLarge) throw new Error(`refused: ${err.message}, which no real document does`);
    throw err;
  }
}

/** A Pages, Keynote or Numbers file shows the picture of its first page it keeps for Finder. */
function iworkPreview(parts: Map<string, Buffer>, format: ViewFormat): OfficeView {
  const preview = ["preview.jpg", "QuickLook/Preview.jpg", "QuickLook/Thumbnail.jpg", "preview-web.jpg"].map((n) => parts.get(n)).find(Boolean);
  if (!preview) throw new Error("this file keeps no preview; open it on a Mac");
  return {
    kind: "picture",
    format,
    src: `data:image/jpeg;base64,${preview.toString("base64")}`,
    notes: [`The first ${format === "key" ? "slide" : "page"}, as the file keeps it for previews. Open it on a Mac for the rest.`],
  };
}
