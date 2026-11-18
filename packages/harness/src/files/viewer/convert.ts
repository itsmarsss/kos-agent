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

export function convert(bytes: Uint8Array, format: ViewFormat): OfficeView {
  switch (format) {
    case "csv":
    case "tsv":
      return delimitedToView(new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, ""), format);
    case "xls":
      return workbookToView(bytes, format);
    case "xlsx":
    case "ods":
      // Inflated once here under the caps first: SheetJS's own inflater is not bounded.
      zipParts(bytes);
      return workbookToView(bytes, format);
    case "numbers":
      zipParts(bytes);
      try {
        return workbookToView(bytes, format);
      } catch {
        return iworkPreview(bytes, format);
      }
    case "docx": {
      const view = docxToView(zipParts(bytes));
      return { ...view, html: sanitizeHtml(view.html) };
    }
    case "pptx":
      return pptxToView(zipParts(bytes));
    case "pages":
    case "key":
      return iworkPreview(bytes, format);
    default:
      throw new Error(`a ${format} file is not read here`);
  }
}

/** The archive's parts, every one inflated under the caps; a bomb is refused, not followed. */
function zipParts(bytes: Uint8Array): Map<string, Buffer> {
  if (!isZip(bytes)) throw new Error("the file is not what its name says: it is not a zip archive");
  try {
    return readZip(bytes, { entryMax: ZIP_ENTRY_MAX, totalMax: ZIP_TOTAL_MAX, oversize: "refuse" });
  } catch (err) {
    if (err instanceof ZipTooLarge) throw new Error(`refused: ${err.message}, which no real document does`);
    throw err;
  }
}

/** A Pages, Keynote or Numbers file shows the picture of its first page it keeps for Finder. */
function iworkPreview(bytes: Uint8Array, format: ViewFormat): OfficeView {
  const parts = zipParts(bytes);
  const preview = ["preview.jpg", "QuickLook/Preview.jpg", "QuickLook/Thumbnail.jpg", "preview-web.jpg"].map((n) => parts.get(n)).find(Boolean);
  if (!preview) throw new Error("this file keeps no preview; open it on a Mac");
  return {
    kind: "picture",
    format,
    src: `data:image/jpeg;base64,${preview.toString("base64")}`,
    notes: [`The first ${format === "key" ? "slide" : "page"}, as the file keeps it for previews. Open it on a Mac for the rest.`],
  };
}
