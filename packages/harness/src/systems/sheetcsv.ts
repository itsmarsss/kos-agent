import type { SheetBook, SheetTab } from "@kos/shared";
import { Workbook, isError, sourceQuery, sourceRows, type Value } from "@kos/shared/sheetformula";

/**
 * A sheet's tab as CSV, for a spreadsheet elsewhere: the column labels, then
 * each row's values as the runtime works them out with the same engine
 * (sheetformula.ts), so a formula exports as its result, a pivot as its
 * groups, and a source tab as the rows its table holds now. Numbers are
 * written plainly (0.25, not 25%; 1650, not $1,650.00) so the spreadsheet
 * reads them as numbers; the totals row is the runtime's to draw, not data.
 *
 * RFC 4180: CRLF between rows, a field quoted when it holds a comma, a quote
 * or a line break. A UTF-8 byte-order mark leads, without which Excel reads
 * the file in the machine's code page and mangles every accent. A text cell
 * that a spreadsheet would run as a formula (=, +, -, @, a tab or a return
 * first, unless the cell is a plain number like -3) is
 * led by an apostrophe, OWASP's guard against CSV injection: a row a
 * stranger's email filled cannot become a formula on the owner's machine.
 */

const BOM = "\uFEFF";

/** What a spreadsheet would start a formula with, in a text cell. */
const FORMULA_START = /^[=+\-@\t\r]/;
/** A text cell that is a number and nothing else, which a spreadsheet reads as that number: the one start it is left. */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

function field(v: Value): string {
  if (v === null) return "";
  if (isError(v)) return v.error;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  // Fifteen digits, as a spreadsheet holds them: 169.11, not the 169.10999999999999 a sum of floats leaves.
  if (typeof v === "number") return Number.isFinite(v) ? String(Number(v.toPrecision(15))) : "";
  const text = FORMULA_START.test(v) && !PLAIN_NUMBER.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One tab of a workbook (source tabs already holding their rows) as CSV text. */
export function tabCsv(book: SheetBook, tab: number): string {
  const wb = new Workbook(book);
  const columns = wb.columns(tab);
  const lines = [columns.map((c) => field(c.label)).join(",")];
  for (let row = 1; row <= wb.rowCount(tab); row++) lines.push(columns.map((_, col) => field(wb.value(tab, row, col))).join(","));
  return `${BOM}${lines.join("\r\n")}\r\n`;
}

/** One page of a read, as window.kos answers one: truncated when the server cut it short. */
export interface SourcePage {
  rows: Record<string, unknown>[];
  truncated?: boolean;
}

/** A read of a project table through the artifact's bridge, a page at a time (LIMIT ? OFFSET ?). */
export type SourceRead = (sql: string, params: number[]) => Promise<SourcePage>;

/** A source tab the export cannot read: its table refused it, or it is larger than an export takes. */
export class SourceRefusal extends Error {}

/** The rows the server answers a read with at most, so a page this long may have more after it. */
export const SOURCE_PAGE = 500;
/** The most rows an export reads from one table; past it, the table is the place to export from. */
export const SOURCE_ROWS_MAX = 100_000;

/** Every row a source tab's table holds, read a page at a time, up to SOURCE_ROWS_MAX. */
async function allRows(tab: SheetTab, sql: string, read: SourceRead): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (;;) {
    let got: SourcePage;
    try {
      got = await read(`${sql} LIMIT ? OFFSET ?`, [SOURCE_PAGE, rows.length]);
    } catch (err) {
      throw new SourceRefusal(`the tab "${tab.name}" cannot be read: ${err instanceof Error ? err.message : String(err)}`);
    }
    rows.push(...got.rows);
    if (rows.length > SOURCE_ROWS_MAX) throw new SourceRefusal(`the tab "${tab.name}" has more than ${SOURCE_ROWS_MAX.toLocaleString("en-US")} rows; export its table from the project instead`);
    if (!got.rows.length || (!got.truncated && got.rows.length < SOURCE_PAGE)) return rows;
  }
}

/**
 * The workbook with each source tab holding every row its table has now
 * (not the frame's first 500), read through the artifact's own bridge a
 * page at a time and one tab after another, so its declarations, the
 * server's checks and its queue hold as they do for the frame. A tab whose
 * read is refused refuses the export, saying which and why.
 */
export async function withSources(book: SheetBook, read: SourceRead): Promise<SheetBook> {
  const sheets: SheetTab[] = [];
  for (const tab of book.sheets) {
    if (!tab.source) {
      sheets.push(tab);
      continue;
    }
    const sql = sourceQuery(tab);
    if (!sql) throw new SourceRefusal(`the tab "${tab.name}" reads no plain table, so it has nothing to export`);
    sheets.push({ ...tab, rows: sourceRows(tab, await allRows(tab, sql, read)) });
  }
  return { ...book, sheets };
}
