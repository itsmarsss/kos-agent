/**
 * Changing a workbook's shape: rows and columns put in and taken out, a
 * column renamed or retyped. Each keeps the rest of the workbook pointing
 * where it did, as a spreadsheet does: formulas in every tab, the charts'
 * ranges, the totals and the pivots that read the tab. A reference to what
 * was deleted becomes #REF!, a total on it goes. Pure over the book it is
 * given, which it changes in place; the runtime keeps a copy for undo.
 */

import type { SheetBook, SheetCell, SheetColumn, SheetColumnType } from "@kos/shared";
import { columnLetter, findColumn, rewriteRefs, type Ref } from "@kos/shared/sheetformula";

import { coerce } from "./sheetimport.js";

type Axis = "row" | "col";

/** Where a span [a, b] of rows or columns lands when `count` are put in before `at` (count > 0) or taken out from it (count < 0); null when all of it went. */
function shiftSpan(a: number, b: number, at: number, count: number): [number, number] | null {
  if (count > 0) return [a >= at ? a + count : a, b >= at ? b + count : b];
  const last = at - count - 1;
  const map = (x: number): number | null => (x < at ? x : x > last ? x + count : null);
  const na = map(a) ?? at;
  const nb = map(b) ?? at - 1;
  return na > nb ? null : [na, nb];
}

const sameName = (a: string | undefined, b: string): boolean => a !== undefined && a.trim().toLowerCase() === b.trim().toLowerCase();

/** Move every reference to tab `t` along one axis, in every formula and chart of the book. */
function shiftRefs(book: SheetBook, t: number, axis: Axis, at: number, count: number): void {
  const name = book.sheets[t]!.name;
  const move =
    (own: number) =>
    (ref: Ref): Ref | null => {
      const target = ref.sheet === undefined ? own === t : sameName(ref.sheet, name);
      if (!target) return ref;
      const [a, b] = axis === "row" ? [ref.row, ref.row2 ?? ref.row] : [ref.col, ref.col2 ?? ref.col];
      // A range keeps its corners as written, low and high, whichever way round they were.
      const span = shiftSpan(Math.min(a, b), Math.max(a, b), at, count);
      if (!span) return null;
      const [lo, hi] = a <= b ? span : [span[1], span[0]];
      const two = ref.col2 !== undefined;
      if (axis === "row") return { ...ref, row: lo, ...(two ? { row2: hi } : {}) };
      return { ...ref, col: lo, ...(two ? { col2: hi } : {}) };
    };
  book.sheets.forEach((tab, own) => {
    for (const row of tab.rows ?? []) {
      for (let i = 0; i < row.length; i++) {
        const cell = row[i];
        if (typeof cell === "string" && cell.startsWith("=")) row[i] = rewriteRefs(cell, move(own));
      }
    }
  });
  for (const chart of book.charts ?? []) {
    const own = chart.sheet === undefined ? 0 : book.sheets.findIndex((s) => sameName(s.name, chart.sheet!));
    for (const key of ["labels", "values"] as const) chart[key] = rewriteRefs(`=${chart[key]}`, move(own)).slice(1);
  }
}

/** A column named by label or letter, once columns move: a label as it was, a letter moved with its column; undefined when its column went. */
function shiftName(ref: string, columns: readonly SheetColumn[], at: number, count: number): string | undefined {
  const i = findColumn(columns, ref);
  if (i < 0) return ref;
  if (count < 0 && i >= at && i < at - count) return undefined;
  if (columns.some((c) => sameName(c.label, ref))) return ref;
  return columnLetter(shiftSpan(i, i, at, count)![0]);
}

/** Keep a tab's totals, freeze and the pivots grouping it on their columns when columns move; called before they do. */
function shiftNames(book: SheetBook, t: number, at: number, count: number): void {
  const tab = book.sheets[t]!;
  const columns = tab.columns;
  if (tab.totals) {
    const totals: NonNullable<typeof tab.totals> = {};
    for (const [ref, fn] of Object.entries(tab.totals)) {
      const next = shiftName(ref, columns, at, count);
      if (next !== undefined) totals[next] = fn;
    }
    tab.totals = totals;
  }
  for (const other of book.sheets) {
    const p = other.pivot;
    if (!p || !sameName(p.from, tab.name)) continue;
    p.by = shiftName(p.by, columns, at, count) ?? "#REF!";
    p.values = p.values.map((v) => ({ ...v, column: shiftName(v.column, columns, at, count) ?? "#REF!" }));
  }
  if (tab.freeze !== undefined && at < tab.freeze) tab.freeze = Math.max(0, tab.freeze + count);
}

/** A label no column of the tab has: "Column F", or "Name 2" after "Name". */
export function freshLabel(columns: readonly SheetColumn[], base: string): string {
  if (!columns.some((c) => sameName(c.label, base))) return base;
  for (let n = 2; ; n++) if (!columns.some((c) => sameName(c.label, `${base} ${n}`))) return `${base} ${n}`;
}

/** Put a column in before column `at` (0 is first; the count of columns is last). */
export function insertColumn(book: SheetBook, t: number, at: number, column: SheetColumn): void {
  const tab = book.sheets[t]!;
  shiftNames(book, t, at, 1);
  shiftRefs(book, t, "col", at, 1);
  tab.columns.splice(at, 0, column);
  for (const row of tab.rows ?? []) if (row.length >= at) row.splice(at, 0, null);
}

/** Take a column out, and its cells with it. */
export function deleteColumn(book: SheetBook, t: number, at: number): void {
  const tab = book.sheets[t]!;
  shiftNames(book, t, at, -1);
  shiftRefs(book, t, "col", at, -1);
  tab.columns.splice(at, 1);
  for (const row of tab.rows ?? []) row.splice(at, 1);
}

/** Rename a column, and what names it: its totals and the pivots of its tab. A source column keeps reading the table column it did. */
export function renameColumn(book: SheetBook, t: number, at: number, label: string): void {
  const tab = book.sheets[t]!;
  const column = tab.columns[at]!;
  const was = column.label;
  if (tab.source && column.column === undefined) column.column = was;
  column.label = label;
  if (tab.totals) tab.totals = Object.fromEntries(Object.entries(tab.totals).map(([ref, fn]) => [sameName(ref, was) ? label : ref, fn]));
  for (const other of book.sheets) {
    const p = other.pivot;
    if (!p || !sameName(p.from, tab.name)) continue;
    if (sameName(p.by, was)) p.by = label;
    p.values = p.values.map((v) => (sameName(v.column, was) ? { ...v, column: label } : v));
  }
}

/**
 * Give a column another type. Its stored values that read as the new type
 * are kept as it keeps them (text "1,200" a number, "Nov 3, 2026" a date);
 * what does not read stays as it was, and is counted. A currency takes the
 * workbook's own currency when the column had none.
 */
export function retypeColumn(book: SheetBook, t: number, at: number, type: SheetColumnType): { unread: number } {
  const tab = book.sheets[t]!;
  const column = tab.columns[at]!;
  if (type === "text") delete column.type;
  else column.type = type;
  if (type === "currency" && !column.currency) {
    const other = book.sheets.flatMap((s) => s.columns).find((c) => c.type === "currency" && c.currency);
    if (other?.currency) column.currency = other.currency;
  }
  let unread = 0;
  for (const row of tab.rows ?? []) {
    const cell = row[at];
    if (typeof cell !== "string" || cell.startsWith("=")) continue;
    const got = coerce(cell.startsWith("'=") ? cell.slice(1) : cell, column);
    if ("cell" in got) row[at] = got.cell;
    else unread += 1;
  }
  return { unread };
}

/** Put rows in before data row `at` (from 1; one past the last appends). */
export function insertRows(book: SheetBook, t: number, at: number, rows: SheetCell[][]): void {
  const tab = book.sheets[t]!;
  shiftRefs(book, t, "row", at, rows.length);
  tab.rows!.splice(at - 1, 0, ...rows);
}

/** Take data rows out, by number (from 1), in any order. */
export function deleteRows(book: SheetBook, t: number, rows: readonly number[]): void {
  const tab = book.sheets[t]!;
  for (const r of [...new Set(rows)].sort((a, b) => b - a)) {
    if (r < 1 || r > tab.rows!.length) continue;
    shiftRefs(book, t, "row", r, -1);
    tab.rows!.splice(r - 1, 1);
  }
}
