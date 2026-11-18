import { read, utils, type CellObject, type WorkSheet } from "xlsx";

import type { ViewCell as Cell, ViewSheet as Sheet, SheetView, ViewFormat } from "@kos/shared";

/**
 * A workbook as sheets to look at.
 *
 * Excel's two formats, OpenDocument's and Numbers' are read by SheetJS,
 * which keeps each cell's value as the file formats it (a date as a date, a
 * price with its currency), the merged ranges and the column widths. Only
 * values are read: no formulas evaluated, no styles, no macros (SheetJS
 * never runs one, and is not asked to keep the VBA). A sheet past its caps
 * is cut, and the view says how much was shown. CSV and TSV are read here
 * directly, so a value is never reinterpreted (a "0123" stays "0123").
 */

export const ROWS_MAX = 2000;
export const COLS_MAX = 100;
const SHEETS_MAX = 40;
/** Every cell shown across the workbook, so forty sheets of 2,000 rows are not all sent. */
const CELLS_MAX = 400_000;
/** A cell's words past this are cut; a sheet cell is not a document. */
const CELL_TEXT_MAX = 2000;

const NUMBER = /^[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?([eE][-+]?\d+)?%?$/;

export function workbookToView(bytes: Uint8Array, format: ViewFormat): SheetView {
  const book = read(bytes, {
    type: "buffer",
    // Rows past the cap are never built; one more says the sheet went on.
    sheetRows: ROWS_MAX + 1,
    cellFormula: false,
    cellHTML: false,
    cellStyles: false,
    bookVBA: false,
    WTF: false,
  });
  const notes: string[] = [];
  const sheets: (Sheet & { cut: boolean })[] = [];
  let budget = CELLS_MAX;
  const hidden = new Set((book.Workbook?.Sheets ?? []).filter((s) => s.Hidden).map((s) => s.name));
  for (const name of book.SheetNames.slice(0, SHEETS_MAX)) {
    if (hidden.has(name)) continue;
    const ws = book.Sheets[name];
    if (!ws) continue;
    const sheet = readSheet(name, ws, budget);
    budget -= sheet.rows.length * sheet.cols;
    sheets.push(sheet);
    if (budget <= 0) break;
  }
  if (book.SheetNames.length > sheets.length + hidden.size) notes.push(`Showing ${sheets.length} of ${book.SheetNames.length} sheets.`);
  if (hidden.size) notes.push(`${hidden.size} hidden sheet${hidden.size === 1 ? " is" : "s are"} not shown.`);
  return { kind: "sheet", format, sheets: sheets.map(({ cut: _cut, ...sheet }) => sheet), notes: [...notes, ...cutNotes(sheets)] };
}

function readSheet(name: string, ws: WorkSheet, budget: number): Sheet & { cut: boolean } {
  // The extent the file declares; !fullref is the whole sheet when sheetRows cut it.
  const ref = (ws["!fullref"] as string | undefined) ?? ws["!ref"];
  if (!ref) return { name, rows: [], cols: 0, totalRows: 0, totalCols: 0, cut: false };
  const full = utils.decode_range(ref);
  const totalRows = full.e.r - full.s.r + 1;
  const totalCols = full.e.c - full.s.c + 1;
  const cols = Math.min(totalCols, COLS_MAX);
  const rowsShown = Math.max(0, Math.min(totalRows, ROWS_MAX, Math.floor(budget / Math.max(1, cols))));
  const rows: (Cell | null)[][] = [];
  for (let r = 0; r < rowsShown; r++) {
    const row: (Cell | null)[] = [];
    for (let c = 0; c < cols; c++) {
      const cell = ws[utils.encode_cell({ r: full.s.r + r, c: full.s.c + c })] as CellObject | undefined;
      row.push(cell ? cellOf(cell) : null);
    }
    rows.push(row);
  }
  // Trailing empty rows a file declares are not worth a screen of blanks.
  while (rows.length && rows[rows.length - 1]!.every((c) => c === null)) rows.pop();
  const widths = (ws["!cols"] ?? []).slice(0, cols).map((c) => Math.round(c?.wpx ?? (c?.wch ? c.wch * 7 + 10 : 0)));
  const merges = (ws["!merges"] ?? [])
    .map((m) => ({ r: m.s.r - full.s.r, c: m.s.c - full.s.c, rows: m.e.r - m.s.r + 1, cols: m.e.c - m.s.c + 1 }))
    .filter((m) => m.r >= 0 && m.c >= 0 && m.r < rows.length && m.c < cols && (m.rows > 1 || m.cols > 1));
  return {
    name,
    rows,
    cols,
    totalRows,
    totalCols,
    cut: rowsShown < totalRows,
    ...(widths.some((w) => w > 0) ? { widths } : {}),
    ...(merges.length ? { merges } : {}),
  };
}

function cellOf(cell: CellObject): Cell | null {
  if (cell.t === "z" || (cell.v === undefined && cell.w === undefined)) return null;
  const text = (cell.w ?? (cell.v instanceof Date ? cell.v.toISOString().slice(0, 10) : String(cell.v ?? ""))).slice(0, CELL_TEXT_MAX);
  const t = cell.t === "n" || cell.t === "b" || cell.t === "e" || cell.t === "d" ? cell.t : "s";
  return { v: text, t };
}

/** What was cut from each sheet, said once per sheet. */
function cutNotes(sheets: (Sheet & { cut?: boolean })[]): string[] {
  return sheets
    .filter((s) => s.cut || s.cols < s.totalCols)
    .map((s) => `${sheets.length > 1 ? `${s.name}: s` : "S"}howing ${s.cut ? `the first ${s.rows.length.toLocaleString("en")} of ${s.totalRows.toLocaleString("en")} rows` : "every row"}${s.cols < s.totalCols ? ` and ${s.cols} of ${s.totalCols} columns` : ""}. Download it for the rest.`);
}

/** CSV or TSV, read by the RFC 4180 rules: quotes, doubled quotes, line breaks inside quotes. */
export function delimitedToView(text: string, format: "csv" | "tsv"): SheetView {
  const sep = format === "tsv" ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let totalRows = 0;
  let totalCols = 0;
  const endRow = (): void => {
    row.push(field);
    field = "";
    totalRows++;
    totalCols = Math.max(totalCols, row.length);
    if (rows.length < ROWS_MAX) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === sep) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else field += ch;
  }
  if (field !== "" || row.length) endRow();
  const cols = Math.min(totalCols, COLS_MAX);
  const sheet: Sheet & { cut: boolean } = {
    name: format.toUpperCase(),
    rows: rows.map((r) => Array.from({ length: cols }, (_, c) => {
      const v = (r[c] ?? "").slice(0, CELL_TEXT_MAX);
      return v === "" ? null : { v, t: NUMBER.test(v.trim()) && v.trim() !== "" ? ("n" as const) : ("s" as const) };
    })),
    cols,
    totalRows,
    totalCols,
    cut: rows.length < totalRows,
  };
  const { cut: _cut, ...shown } = sheet;
  return { kind: "sheet", format, sheets: [shown], notes: cutNotes([sheet]) };
}
