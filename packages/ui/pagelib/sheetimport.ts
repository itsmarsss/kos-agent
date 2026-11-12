/**
 * Rows coming into a sheet from elsewhere: a range pasted from a
 * spreadsheet (Excel, Google Sheets and Numbers put it on the clipboard as
 * tab-separated text and as an HTML table), or a CSV file. Pure, so tested
 * alone; the runtime (sheet.ts) asks before it replaces anything.
 *
 * What comes in is data, never markup or a formula: an HTML table is read
 * for its text, and a cell that starts with "=" is kept as text where the
 * column holds text (led by an apostrophe, sheetformula.ts) and refused where
 * it holds figures, dates or yes and no.
 */

import type { SheetCell, SheetColumn } from "@kos/shared";
import { parseDate } from "@kos/shared/sheetformula";

export type Delimiter = "," | ";" | "\t";
export const DELIMITERS: readonly Delimiter[] = [",", ";", "\t"];

/** Text in rows of fields, RFC 4180: quoted fields may hold the delimiter, a doubled quote and line breaks; CRLF, LF or CR end a row; a BOM is dropped. */
export function parseDelimited(text: string, delimiter: Delimiter): string[][] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const endRow = (): void => {
    row.push(field);
    rows.push(row);
    row = [];
    field = "";
  };
  while (i < src.length) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (c === '"') quoted = false;
      else field += c;
      i += 1;
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\r" || c === "\n") {
      endRow();
      if (c === "\r" && src[i + 1] === "\n") i += 1;
    } else field += c;
    i += 1;
  }
  if (field !== "" || row.length) endRow();
  return rows;
}

/** A file's bytes as text: UTF-8 when they are (its BOM kept for the parser to drop), else Windows-1252, as an older Excel on Windows saves a CSV. */
export function decodeText(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    // By hand, since a decoder may take windows-1252 for Latin-1 and miss its letters at 0x80 to 0x9f (the euro sign, curly quotes).
    let text = "";
    for (const b of new Uint8Array(bytes)) text += b >= 0x80 && b <= 0x9f ? CP1252[b - 0x80]! : String.fromCharCode(b);
    return text;
  }
}

/** Windows-1252's 0x80 to 0x9f; the five it leaves unassigned read as their Latin-1 controls. */
const CP1252 = "\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178";

/** The delimiter a file uses: the one that splits its first lines into the same number of fields, the most fields winning; a comma when none does. */
export function detectDelimiter(text: string): Delimiter {
  const sample = text.replace(/^﻿/, "").split(/\r\n|\n|\r/).filter((l) => l.trim() !== "").slice(0, 10).join("\n");
  let best: { d: Delimiter; width: number; even: boolean } = { d: ",", width: 1, even: false };
  for (const d of DELIMITERS) {
    const widths = parseDelimited(sample, d).map((r) => r.length);
    if (!widths.length) continue;
    const even = widths.every((w) => w === widths[0]);
    const width = Math.min(...widths);
    if (width < 2) continue;
    if ((even && !best.even) || (even === best.even && width > best.width)) best = { d, width, even };
  }
  return best.d;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** A line break a <br> made, held apart while white space is folded. */
const BREAK = "\u2028";

/** HTML text as the words it shows: tags gone, runs of white space one space, a <br> a line break, entities decoded. */
function htmlText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, BREAK)
    .replace(/<[^>]*>/g, "")
    .replace(/[ \t\r\n\f]+/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? whole;
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    })
    .replace(/\u00a0/g, " ")
    .replace(new RegExp(` ?${BREAK} ?`, "g"), "\n")
    .trim();
}

/**
 * The first table in clipboard HTML, as rows of its cells' text. It is read
 * as text by patterns, never parsed into a document, so nothing in it runs
 * or loads, and the frame's guard (which refuses a <meta> such HTML holds)
 * is never asked. A cell spanning columns leaves the ones it covers empty.
 */
export function tableFromHtml(html: string): string[][] {
  const clean = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(style|script|head)\b[\s\S]*?<\/\1\s*>/gi, "");
  const table = /<table\b[\s\S]*?(?:<\/table\s*>|$)/i.exec(clean)?.[0];
  if (!table) return [];
  const rows: string[][] = [];
  for (const tr of table.split(/<tr\b[^>]*>/i).slice(1)) {
    const row: string[] = [];
    for (const m of tr.matchAll(/<t([dh])\b([^>]*)>([\s\S]*?)(?=<t[dh]\b|<\/tr|<\/table|$)/gi)) {
      row.push(htmlText(m[3]!.replace(/<\/t[dh]\s*>[\s\S]*$/i, "")));
      const span = Number(/colspan\s*=\s*["']?(\d+)/i.exec(m[2]!)?.[1] ?? 1);
      for (let k = 1; k < Math.min(span, 100); k++) row.push("");
    }
    if (row.length) rows.push(row);
  }
  return rows;
}

/** What a paste brings, as rows: the clipboard's text, tab-separated as every spreadsheet writes it, else its HTML table. */
export function clipboardRows(text: string, html: string): string[][] {
  const rows = text.trim() !== "" ? parseDelimited(text.replace(/(\r\n|\n|\r)$/, ""), "\t") : tableFromHtml(html);
  return rows.filter((r, i) => i < rows.length - 1 || r.some((f) => f.trim() !== ""));
}

/** A cell for a column, or why the text does not fit it. */
export type Coerced = { cell: SheetCell } | { error: string };

const quoteOf = (t: string): string => `"${t.length > 40 ? `${t.slice(0, 39)}…` : t}"`;

/** A figure as people write one: thousands separated by commas or dots, a decimal comma, a currency sign or code, a minus or parentheses for less than nothing. */
export function parseNumber(text: string, percent: boolean): number | undefined {
  let t = text.replace(/[\s  ']/g, "");
  let negative = false;
  const paren = /^\((.*)\)$/.exec(t);
  if (paren) {
    negative = true;
    t = paren[1]!;
  }
  t = t.replace(/^([+-]?)(?:[A-Z]{3}|[$€£¥₹]|[A-Z]{1,2}\$)/, "$1").replace(/(?:[A-Z]{3}|[$€£¥₹])$/, "");
  if (t.startsWith("-") && t.endsWith("-")) return undefined;
  if (t.endsWith("-")) t = `-${t.slice(0, -1)}`;
  const pct = percent && t.endsWith("%");
  if (pct) t = t.slice(0, -1);
  const comma = t.lastIndexOf(",");
  const dot = t.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) t = comma > dot ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  else if (comma >= 0) t = /^[+-]?\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, "") : /^[+-]?\d*,\d+$/.test(t) ? t.replace(",", ".") : t;
  else if (/^[+-]?\d{1,3}(\.\d{3}){2,}$/.test(t)) t = t.replace(/\./g, "");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return undefined;
  const n = Number(t) * (negative ? -1 : 1);
  if (!Number.isFinite(n)) return undefined;
  return pct ? n / 100 : n;
}

const YES = /^(true|yes|y|1|x|✓|✔|on)$/i;
const NO = /^(false|no|n|0|off)$/i;

/** Text from outside as a cell of a column, by the column's type; a formula is never one. */
export function coerce(text: string, column: SheetColumn | undefined): Coerced {
  const t = text.trim();
  if (t === "") return { cell: null };
  const type = column?.type ?? "text";
  if (type === "text") return { cell: t.startsWith("=") ? `'${t}` : t };
  if (t.startsWith("=")) return { error: `${quoteOf(t)} is a formula, and what comes in is kept as values` };
  switch (type) {
    case "number":
    case "currency":
    case "percent": {
      const n = parseNumber(t, type === "percent");
      return n === undefined ? { error: `${quoteOf(t)} is not a number` } : { cell: n };
    }
    case "date": {
      const d = parseDate(t);
      return d === undefined ? { error: `${quoteOf(t)} is not a date` } : { cell: d };
    }
    case "bool":
      return YES.test(t) ? { cell: true } : NO.test(t) ? { cell: false } : { error: `${quoteOf(t)} is not yes or no` };
  }
}

const norm = (s: string): string => s.trim().toLowerCase();
const names = (c: SheetColumn): string[] => [norm(c.label), ...(c.column ? [norm(c.column)] : [])];

/** Whether a row is the columns' own header: most of its filled fields name a column. */
export function isHeader(row: readonly string[], columns: readonly SheetColumn[]): boolean {
  const filled = row.filter((f) => f.trim() !== "");
  const hits = filled.filter((f) => columns.some((c) => names(c).includes(norm(f)))).length;
  return hits > 0 && hits * 2 >= filled.length;
}

/** For each of the tab's columns, the field of a row that fills it (-1 none): by the header's names, else in order. */
export function autoMap(header: readonly string[] | undefined, width: number, columns: readonly SheetColumn[]): number[] {
  if (header) {
    const byName = columns.map((c) => header.findIndex((h) => names(c).includes(norm(h))));
    if (byName.some((i) => i >= 0)) return byName;
  }
  return columns.map((_, i) => (i < width ? i : -1));
}

/** Where a value that did not fit came from, as the owner finds it: "File row 4" (its rows counted with the header), "Row 3" (a row of the grid, by its number) or "New row 2" (one a paste adds). */
const where = (place: string, column: SheetColumn | undefined, col: number): string => `${place}, ${column?.label ?? `column ${col + 1}`}`;

/** Rows to add from a file, mapped onto the tab's columns; a line with nothing for a mapped column adds nothing, and a value that does not fit leaves its cell empty and says so. */
export function importRows(rows: readonly string[][], header: boolean, map: readonly number[], columns: readonly SheetColumn[]): { rows: SheetCell[][]; errors: string[] } {
  const out: SheetCell[][] = [];
  const errors: string[] = [];
  rows.forEach((fields, i) => {
    if (header && i === 0) return;
    const row = columns.map((c, col) => {
      const from = map[col] ?? -1;
      if (from < 0) return null;
      const got = coerce(fields[from] ?? "", c);
      if ("cell" in got) return got.cell;
      errors.push(`${where(`File row ${i + 1}`, c, col)}: ${got.error}`);
      return null;
    });
    // A line with nothing for any mapped column adds nothing (and a table would refuse an insert of no values).
    if (row.some((c) => c !== null)) out.push(row);
  });
  return { rows: out, errors };
}

/** A paste worked out against a tab before anything changes. */
export interface PastePlan {
  /** Cells set in rows the tab has, by data row (from 1) and column. */
  cells: { row: number; col: number; cell: SheetCell }[];
  /** Rows added after the last. */
  added: SheetCell[][];
  /** How many filled cells the paste would replace with something else. */
  replaces: number;
  /** Values that do not fit their column, left as they were. */
  errors: string[];
  /** How many pasted columns reach past the tab's last, which are left out. */
  dropped: number;
}

/**
 * A pasted block laid over a tab from a cell: its rows go down the rows as
 * shown (`targets`, data row numbers in view order from the pasted-at row),
 * then past the last as new rows; its columns go right from `col`. A block
 * led by the tab's own header is mapped by those names from the first
 * column instead, and adds its rows.
 */
export function planPaste(block: readonly string[][], targets: readonly number[], col: number, columns: readonly SheetColumn[], rawAt: (row: number, col: number) => SheetCell): PastePlan {
  const plan: PastePlan = { cells: [], added: [], replaces: 0, errors: [], dropped: 0 };
  const width = Math.max(0, ...block.map((r) => r.length));
  const headed = block.length > 1 && isHeader(block[0]!, columns);
  const map = headed ? autoMap(block[0], width, columns) : columns.map((_, c) => (c >= col && c - col < width ? c - col : -1));
  const used = new Set(map.filter((i) => i >= 0));
  plan.dropped = Array.from({ length: width }, (_, i) => i).filter((i) => !used.has(i) && block.some((r) => (r[i] ?? "").trim() !== "")).length;
  const body = headed ? block.slice(1) : block;
  const rowsIn = headed ? [] : targets;
  body.forEach((fields, i) => {
    const row = rowsIn[i];
    const fresh: SheetCell[] = columns.map(() => null);
    columns.forEach((c, k) => {
      const from = map[k]!;
      if (from < 0 || from >= fields.length) return;
      const got = coerce(fields[from]!, c);
      if ("error" in got) {
        plan.errors.push(`${where(row === undefined ? `New row ${plan.added.length + 1}` : `Row ${row}`, c, k)}: ${got.error}`);
        return;
      }
      if (row === undefined) {
        fresh[k] = got.cell;
        return;
      }
      const before = rawAt(row, k);
      if (before === got.cell) return;
      if (before !== null && before !== "") plan.replaces += 1;
      plan.cells.push({ row, col: k, cell: got.cell });
    });
    if (row === undefined && fresh.some((c) => c !== null)) plan.added.push(fresh);
  });
  return plan;
}
