/**
 * The sheet runtime's engine, apart from the page: formulas, a workbook's
 * values, totals, pivots and number formats, and the query a source tab
 * reads. Pure, so it is tested alone, and shared: the runtime draws a
 * workbook with it, and the server exports one with it (a CSV of a tab's
 * values, not its formulas).
 *
 * Data rows are numbered from 1 (the header is not a row) and column A is
 * the first column. A cell is a value, or a formula starting with "=";
 * text that starts with "=" and is not a formula is kept led by an
 * apostrophe ("'=x" reads as "=x"), as a spreadsheet keeps it. Dates are ISO
 * text, and arithmetic on one is on its serial (sheetdates.ts).
 * Precedence follows the common spreadsheet one: comparison, then &, then
 * + and -, then * and /, then ^, then a unary minus (so -2^2 is 4).
 */

import type { SheetAggregate, SheetBook, SheetCell, SheetColumn, SheetTab } from "./artifacts.js";
import { dateDiff, isoOf, isoSerial, localIso, partsOf, serialOf, type DateDiffUnit } from "./sheetdates.js";

export { isoOf, parseDate } from "./sheetdates.js";

export type ErrorCode = "#REF!" | "#DIV/0!" | "#NAME?" | "#VALUE!" | "#N/A" | "#NUM!" | "#CYCLE!";

export interface SheetError {
  error: ErrorCode;
  why: string;
}

export type Value = number | string | boolean | null | SheetError;

export const isError = (v: unknown): v is SheetError => typeof v === "object" && v !== null && "error" in v;
const err = (error: ErrorCode, why: string): SheetError => ({ error, why });

// —— addresses ——

/** "A" -> 0, "Z" -> 25, "AA" -> 26. */
export function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 0 -> "A", 26 -> "AA". */
export function columnLetter(index: number): string {
  let s = "";
  let n = index + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** A column named by its label (any case) or its letter; -1 when neither. */
export function findColumn(columns: readonly SheetColumn[], ref: string): number {
  const want = ref.trim().toLowerCase();
  const byLabel = columns.findIndex((c) => c.label.trim().toLowerCase() === want);
  if (byLabel !== -1) return byLabel;
  if (/^[a-z]{1,3}$/i.test(want)) {
    const i = columnIndex(want);
    if (i < columns.length) return i;
  }
  return -1;
}

// —— tokens ——

type Token =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "ref"; sheet?: string; col: number; row: number; col2?: number; row2?: number }
  | { t: "name"; v: string }
  | { t: "op"; v: string }
  | { t: "("; v?: undefined }
  | { t: ")"; v?: undefined }
  | { t: ","; v?: undefined };

const CELL = /^\$?([A-Za-z]{1,3})\$?([0-9]+)/;

class FormulaSyntax extends Error {}

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const cellAt = (at: number): { col: number; row: number; end: number } | undefined => {
    const m = CELL.exec(src.slice(at));
    if (!m) return undefined;
    // A name like LOG10 or a function SUM( is not a cell.
    const after = src[at + m[0].length];
    if (after !== undefined && /[A-Za-z0-9_(]/.test(after)) return undefined;
    return { col: columnIndex(m[1]!), row: Number(m[2]), end: at + m[0].length };
  };
  const refFrom = (at: number, sheet?: string): number => {
    const a = cellAt(at);
    if (!a) throw new FormulaSyntax(`expected a cell after ${sheet ? `${sheet}!` : "here"}`);
    let end = a.end;
    const tok: Token = { t: "ref", col: a.col, row: a.row, ...(sheet !== undefined ? { sheet } : {}) };
    if (src[end] === ":") {
      const b = cellAt(end + 1);
      if (!b) throw new FormulaSyntax("a range needs a cell after the colon");
      tok.col2 = b.col;
      tok.row2 = b.row;
      end = b.end;
    }
    out.push(tok);
    return end;
  };
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i += 1;
    } else if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
      if (!m) throw new FormulaSyntax(`unexpected "${c}"`);
      out.push({ t: "num", v: Number(m[0]) });
      i += m[0].length;
    } else if (c === '"') {
      let j = i + 1;
      let s = "";
      for (;;) {
        if (j >= src.length) throw new FormulaSyntax("a text value is missing its closing quote");
        if (src[j] === '"') {
          if (src[j + 1] === '"') {
            s += '"';
            j += 2;
            continue;
          }
          break;
        }
        s += src[j];
        j += 1;
      }
      out.push({ t: "str", v: s });
      i = j + 1;
    } else if (c === "'") {
      const close = src.indexOf("'!", i + 1);
      if (close === -1) throw new FormulaSyntax("a quoted tab name needs '! after it");
      i = refFrom(close + 2, src.slice(i + 1, close));
    } else if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i));
      if (m && src[i + m[0].length] === "!") {
        i = refFrom(i + m[0].length + 1, m[0]);
      } else if (cellAt(i)) {
        i = refFrom(i);
      } else if (m) {
        out.push({ t: "name", v: m[0].toUpperCase() });
        i += m[0].length;
      } else {
        throw new FormulaSyntax(`unexpected "${c}"`);
      }
    } else if (c === "(" || c === ")" || c === ",") {
      out.push({ t: c });
      i += 1;
    } else {
      const two = src.slice(i, i + 2);
      if (two === "<=" || two === ">=" || two === "<>") {
        out.push({ t: "op", v: two });
        i += 2;
      } else if ("+-*/^&=<>".includes(c)) {
        out.push({ t: "op", v: c });
        i += 1;
      } else if (c === ";") {
        out.push({ t: "," });
        i += 1;
      } else {
        throw new FormulaSyntax(`unexpected "${c}"`);
      }
    }
  }
  return out;
}

// —— syntax tree ——

export type Node =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "ref"; sheet?: string; col: number; row: number }
  | { k: "range"; sheet?: string; col: number; row: number; col2: number; row2: number }
  | { k: "neg"; x: Node }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "call"; name: string; args: Node[] }
  | { k: "bad"; why: string };

const LEVELS: string[][] = [["=", "<>", "<", ">", "<=", ">="], ["&"], ["+", "-"], ["*", "/"], ["^"]];

/** A formula's tree, from its text with or without the leading "=". Bad syntax parses to a node that evaluates to #NAME?. */
export function parseFormula(text: string): Node {
  let tokens: Token[];
  try {
    tokens = tokenize(text.replace(/^=/, ""));
  } catch (e) {
    return { k: "bad", why: (e as Error).message };
  }
  let p = 0;
  const peek = (): Token | undefined => tokens[p];
  const expect = (t: Token["t"]): void => {
    if (peek()?.t !== t) throw new FormulaSyntax(`expected "${t}"`);
    p += 1;
  };
  const level = (n: number): Node => {
    if (n === LEVELS.length) return unary();
    let left = level(n + 1);
    for (;;) {
      const tok = peek();
      if (tok?.t !== "op" || !LEVELS[n]!.includes(tok.v)) return left;
      p += 1;
      // ^ is right-associative; the rest go left to right.
      const right = n === LEVELS.length - 1 ? level(n) : level(n + 1);
      left = { k: "bin", op: tok.v, a: left, b: right };
    }
  };
  const unary = (): Node => {
    const tok = peek();
    if (tok?.t === "op" && (tok.v === "-" || tok.v === "+")) {
      p += 1;
      const x = unary();
      return tok.v === "-" ? { k: "neg", x } : x;
    }
    return primary();
  };
  const primary = (): Node => {
    const tok = peek();
    if (!tok) throw new FormulaSyntax("the formula ends too soon");
    p += 1;
    switch (tok.t) {
      case "num":
        return { k: "num", v: tok.v };
      case "str":
        return { k: "str", v: tok.v };
      case "ref": {
        const base = { ...(tok.sheet !== undefined ? { sheet: tok.sheet } : {}), col: tok.col, row: tok.row };
        if (tok.col2 === undefined || tok.row2 === undefined) return { k: "ref", ...base };
        return {
          k: "range",
          ...(tok.sheet !== undefined ? { sheet: tok.sheet } : {}),
          col: Math.min(tok.col, tok.col2),
          row: Math.min(tok.row, tok.row2),
          col2: Math.max(tok.col, tok.col2),
          row2: Math.max(tok.row, tok.row2),
        };
      }
      case "(": {
        const inner = level(0);
        expect(")");
        return inner;
      }
      case "name": {
        if (peek()?.t === "(") {
          p += 1;
          const args: Node[] = [];
          if (peek()?.t !== ")") {
            for (;;) {
              args.push(level(0));
              if (peek()?.t === ",") {
                p += 1;
                continue;
              }
              break;
            }
          }
          expect(")");
          return { k: "call", name: tok.v, args };
        }
        if (tok.v === "TRUE" || tok.v === "FALSE") return { k: "bool", v: tok.v === "TRUE" };
        return { k: "bad", why: `"${tok.v}" is not a function or a cell` };
      }
      default:
        throw new FormulaSyntax(`unexpected "${tok.t === "op" ? tok.v : tok.t}"`);
    }
  };
  try {
    const node = level(0);
    if (p < tokens.length) throw new FormulaSyntax("there is more after the formula ends");
    return node;
  } catch (e) {
    return { k: "bad", why: (e as Error).message };
  }
}

// —— values ——

const NUMERIC = new Set(["number", "currency", "percent"]);

/** A stored cell read as its value, before formulas: numeric text in a numeric column becomes a number. */
export function literalOf(cell: SheetCell | undefined, column: SheetColumn | undefined): Value {
  if (cell === undefined || cell === null || cell === "") return null;
  if (typeof cell !== "string") return cell;
  if (cell.startsWith("'=")) return cell.slice(1);
  if (column && NUMERIC.has(column.type ?? "text")) {
    const pct = column.type === "percent" && /%\s*$/.test(cell);
    const n = Number(cell.replace(/[,$€£¥\s%]/g, ""));
    if (cell.trim() !== "" && Number.isFinite(n)) return pct ? n / 100 : n;
  }
  if (column?.type === "bool") {
    if (/^(true|yes|y|1|x)$/i.test(cell.trim())) return true;
    if (/^(false|no|n|0)$/i.test(cell.trim())) return false;
  }
  return cell;
}

function toNumber(v: Value): number | SheetError {
  if (isError(v)) return v;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === null || v === "") return 0;
  const n = Number(v.replace(/,/g, ""));
  if (Number.isFinite(n)) return n;
  return isoSerial(v) ?? err("#VALUE!", `"${v}" is not a number`);
}

/** A value as a date's serial: a number is one already, ISO text names one. */
function toDate(v: Value): number | SheetError {
  if (isError(v)) return v;
  if (typeof v === "number") return v;
  if (v === null) return 0;
  const s = typeof v === "string" ? isoSerial(v) : undefined;
  return s ?? err("#VALUE!", `"${toText(v)}" is not a date`);
}

const toText = (v: Value): string => (v === null ? "" : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : typeof v === "number" ? String(v) : isError(v) ? v.error : v);

function compare(a: Value, b: Value): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  // A date's text against a number is its serial against the number.
  if (typeof a === "number" && typeof b === "string" && isoSerial(b) !== undefined) return a - isoSerial(b)!;
  if (typeof b === "number" && typeof a === "string" && isoSerial(a) !== undefined) return isoSerial(a)! - b;
  if (a === null && typeof b === "number") return -b;
  if (b === null && typeof a === "number") return a;
  const x = toText(a).toLowerCase();
  const y = toText(b).toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Whether a value meets a criterion as SUMIF writes it: 5, "food", ">100", "<>done". */
export function meets(v: Value, criterion: Value): boolean {
  if (isError(v)) return false;
  if (typeof criterion === "string") {
    const m = /^(<=|>=|<>|<|>|=)?(.*)$/s.exec(criterion)!;
    const op = m[1] ?? "=";
    const raw = m[2]!;
    const num = raw.trim() !== "" && Number.isFinite(Number(raw)) ? Number(raw) : undefined;
    const target: Value = num ?? raw;
    const c = typeof target === "number" && typeof v !== "number" ? (v === null ? NaN : Number.isFinite(Number(v)) ? Number(v) - target : NaN) : compare(v, target);
    if (Number.isNaN(c)) return op === "<>";
    switch (op) {
      case "<":
        return c < 0;
      case ">":
        return c > 0;
      case "<=":
        return c <= 0;
      case ">=":
        return c >= 0;
      case "<>":
        return c !== 0;
      default:
        return c === 0;
    }
  }
  return compare(v, criterion) === 0;
}

/** A column's values folded into one: sum, average, min, max or count. */
export function aggregate(fn: SheetAggregate, values: readonly Value[]): Value {
  const firstError = values.find(isError);
  if (firstError && fn !== "count") return firstError;
  const nums = values.filter((v): v is number => typeof v === "number");
  switch (fn) {
    case "count":
      return values.filter((v) => v !== null && v !== "" && !isError(v)).length;
    case "sum":
      return nums.reduce((a, b) => a + b, 0);
    case "average":
      return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : err("#DIV/0!", "there are no numbers to average");
    case "min":
      return nums.length ? Math.min(...nums) : 0;
    case "max":
      return nums.length ? Math.max(...nums) : 0;
  }
}

// —— the workbook ——

/** A range's values row by row, with how many columns it spans. */
type Cells = Value[] & { width?: number; height?: number };
type Arg = Value | Cells;

const flat = (args: Arg[]): Value[] => args.flatMap((a) => (Array.isArray(a) ? a : [a]));
const widthOf = (a: Cells): number => a.width ?? 1;
/** A range one row or one column across, or undefined for a table. */
const vector = (a: Arg): Value[] | undefined => (!Array.isArray(a) ? [a] : widthOf(a) === 1 || a.length === widthOf(a) ? a : undefined);

/** Whether two values are the same for an exact lookup: numbers by value, text in any case, a date's text against its serial. */
function sameValue(a: Value, b: Value): boolean {
  if (isError(a) || isError(b) || a === null || b === null) return false;
  if (typeof a === typeof b) return typeof a === "string" ? a.toLowerCase() === (b as string).toLowerCase() : a === b;
  return (typeof a === "number" || typeof b === "number") && typeof a !== "boolean" && typeof b !== "boolean" && compare(a, b) === 0 && isoSerial(String(typeof a === "string" ? a : b)) !== undefined;
}

/** Whether a lookup may order these two: numbers with numbers (dates among them), text with text. */
const comparable = (a: Value, b: Value): boolean => {
  const kind = (v: Value): string => (typeof v === "number" || (typeof v === "string" && isoSerial(v) !== undefined) ? "n" : typeof v);
  return a !== null && b !== null && !isError(a) && kind(a) === kind(b);
};

/** A wildcard pattern as XLOOKUP's match mode 2 reads one: * any run, ? one character, ~ the next literally. */
function wildcard(pattern: string): RegExp {
  const literal = (c: string): string => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let src = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "~" && i + 1 < pattern.length) src += literal(pattern[++i]!);
    else if (c === "*") src += ".*";
    else if (c === "?") src += ".";
    else src += literal(c);
  }
  return new RegExp(`^${src}$`, "is");
}

/**
 * Where a value is in a list, as MATCH and XLOOKUP find it: 0 the first
 * equal; 1 the last one at or below it in a list sorted up (MATCH's
 * default), -1 the last at or above it in a list sorted down; -1 when none.
 */
function position(want: Value, list: readonly Value[], type: 0 | 1 | -1): number {
  if (type === 0) return list.findIndex((v) => sameValue(v, want));
  let found = -1;
  for (let i = 0; i < list.length; i++) {
    const v = list[i]!;
    if (!comparable(v, want)) continue;
    const c = compare(v, want);
    if (type === 1 ? c > 0 : c < 0) break;
    found = i;
  }
  return found;
}

/** XLOOKUP's nearest match: exact, else the next smaller (-1) or larger (1) anywhere in the list, searched from either end. */
function nearest(want: Value, list: readonly Value[], mode: -1 | 1, order: number[]): number {
  let best = -1;
  for (const i of order) {
    const v = list[i]!;
    if (!comparable(v, want)) continue;
    const c = compare(v, want);
    if (c === 0) return i;
    if (mode === -1 ? c > 0 : c < 0) continue;
    if (best < 0 || (mode === -1 ? compare(v, list[best]!) > 0 : compare(v, list[best]!) < 0)) best = i;
  }
  return best;
}

/** A number rounded at so many places: half away from zero, always away from it, or toward it. */
function roundAt(n: number, places: number, how: "half" | "up" | "down"): number {
  const p = Math.trunc(places);
  const scale = (x: number): number => (p >= 0 ? x * 10 ** p : x / 10 ** -p);
  const unscale = (x: number): number => (p >= 0 ? x / 10 ** p : x * 10 ** -p);
  // Fifteen digits first, so 2.345 * 100 is 234.5, not the 234.49999... a float leaves.
  const x = Number(scale(Math.abs(n)).toPrecision(15));
  const r = how === "half" ? Math.round(x) : how === "up" ? Math.ceil(x) : Math.floor(x);
  return Math.sign(n) * unscale(r) || 0;
}

/** Whether a condition holds, as IF reads one: text when it is not empty, else its truth. */
const truthy = (v: Value): boolean => (typeof v === "string" ? v !== "" : Boolean(v));

const DATE_UNITS: readonly DateDiffUnit[] = ["Y", "M", "D", "MD", "YM", "YD"];

/** What a workbook is worked out with besides its cells. */
export interface WorkbookOptions {
  /** The clock TODAY and NOW read, once per workbook; the machine's when absent. */
  now?: () => Date;
}

/** A cell of a tab, by row (from 1) and column (from 0). */
interface Cell {
  t: number;
  row: number;
  col: number;
}

const keyOf = (c: Cell): string => `${c.t}:${c.row}:${c.col}`;
const isFormula = (cell: SheetCell | undefined): cell is string => typeof cell === "string" && cell.startsWith("=");

/**
 * A workbook's values. Cells are worked out when first asked for and kept,
 * pivots when first read; a formula that comes back to itself is #CYCLE!.
 *
 * A formula's references are worked out first, deepest first, from a stack
 * of its own (`settle`), so a column where each row reads the one above
 * (a running balance) is a loop over its rows, not a call per row, which
 * ran out of stack at a couple of thousand.
 */
export class Workbook {
  private readonly memo = new Map<string, Value>();
  private readonly busy = new Set<string>();
  private readonly pivots = new Map<number, { columns: SheetColumn[]; rows: Value[][] }>();
  private readonly parsed = new Map<string, Node>();
  private clock: Date | undefined;

  constructor(
    readonly book: SheetBook,
    private readonly options: WorkbookOptions = {},
  ) {}

  /** The time this workbook is worked out at: read once, so every TODAY and NOW in it agree. */
  private now(): Date {
    this.clock ??= this.options.now?.() ?? new Date();
    return this.clock;
  }

  tabIndex(name: string | undefined): number {
    if (name === undefined) return 0;
    const want = name.trim().toLowerCase();
    return this.book.sheets.findIndex((s) => s.name.trim().toLowerCase() === want);
  }

  /** The columns of a tab, a pivot's included. */
  columns(t: number): SheetColumn[] {
    const tab = this.book.sheets[t];
    if (!tab) return [];
    return tab.pivot ? this.pivot(t).columns : tab.columns;
  }

  rowCount(t: number): number {
    const tab = this.book.sheets[t];
    if (!tab) return 0;
    return tab.pivot ? this.pivot(t).rows.length : (tab.rows ?? []).length;
  }

  /** A cell's value; row is 1-based, col 0-based. */
  value(t: number, row: number, col: number): Value {
    const tab = this.book.sheets[t];
    if (!tab) return err("#REF!", "no such tab");
    if (tab.pivot) {
      const p = this.pivot(t);
      if (row < 1 || row > p.rows.length || col < 0 || col >= p.columns.length) return null;
      return p.rows[row - 1]![col] ?? null;
    }
    const rows = tab.rows ?? [];
    if (row < 1 || col < 0 || col >= tab.columns.length) return err("#REF!", `${columnLetter(col)}${row} is outside the sheet`);
    if (row > rows.length) return null;
    const key = keyOf({ t, row, col });
    const got = this.memo.get(key);
    if (got !== undefined) return got;
    if (this.busy.has(key)) return err("#CYCLE!", `${columnLetter(col)}${row} depends on itself`);
    const cell = rows[row - 1]![col];
    if (!isFormula(cell)) {
      const v = literalOf(cell, tab.columns[col]);
      this.memo.set(key, v);
      return v;
    }
    this.settle({ t, row, col });
    return this.memo.has(key) ? (this.memo.get(key) as Value) : this.compute({ t, row, col }, cell);
  }

  /** The formula cell a cell is, when it is one not yet worked out and not being worked out now. */
  private pending(c: Cell): string | undefined {
    const tab = this.book.sheets[c.t];
    if (!tab || tab.pivot || c.col < 0 || c.col >= tab.columns.length) return undefined;
    const cell = tab.rows?.[c.row - 1]?.[c.col];
    if (!isFormula(cell)) return undefined;
    const key = keyOf(c);
    return this.memo.has(key) || this.busy.has(key) ? undefined : cell;
  }

  private node(cell: string): Node {
    let node = this.parsed.get(cell);
    if (!node) {
      node = parseFormula(cell);
      this.parsed.set(cell, node);
    }
    return node;
  }

  /** The formula cells a formula reads, which are worked out before it. */
  private references(formula: string, t: number): Cell[] {
    const out: Cell[] = [];
    const walk = [this.node(formula)];
    for (let n = walk.pop(); n; n = walk.pop()) {
      if (n.k === "neg") walk.push(n.x);
      else if (n.k === "bin") walk.push(n.a, n.b);
      else if (n.k === "call") walk.push(...n.args);
      else if (n.k === "ref" || n.k === "range") {
        const tt = n.sheet === undefined ? t : this.tabIndex(n.sheet);
        const tab = this.book.sheets[tt];
        const [row2, col2] = n.k === "range" ? [Math.min(n.row2, tab?.rows?.length ?? 0), Math.min(n.col2, (tab?.columns.length ?? 0) - 1)] : [n.row, n.col];
        for (let row = n.row; row <= row2; row++) for (let col = n.col; col <= col2; col++) if (this.pending({ t: tt, row, col }) !== undefined) out.push({ t: tt, row, col });
      }
    }
    return out;
  }

  /**
   * Work out a formula cell's references before it, deepest first, without
   * recursion. A reference already on the stack is left to the formula to
   * reach (a branch IF never takes, or a real cycle, which `busy` names).
   */
  private settle(start: Cell): void {
    const stack: { cell: Cell; opened: boolean }[] = [{ cell: start, opened: false }];
    const onStack = new Set([keyOf(start)]);
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const formula = this.pending(top.cell);
      if (formula === undefined) {
        stack.pop();
        onStack.delete(keyOf(top.cell));
        continue;
      }
      if (!top.opened) {
        top.opened = true;
        for (const ref of this.references(formula, top.cell.t)) {
          const key = keyOf(ref);
          if (onStack.has(key)) continue;
          onStack.add(key);
          stack.push({ cell: ref, opened: false });
        }
        continue;
      }
      stack.pop();
      onStack.delete(keyOf(top.cell));
      this.compute(top.cell, formula);
    }
  }

  /** Evaluate one formula cell and keep its value. Whatever goes wrong is the cell's error, and never leaves it marked busy. */
  private compute(c: Cell, formula: string): Value {
    const key = keyOf(c);
    this.busy.add(key);
    let v: Value;
    try {
      v = this.scalar(this.evaluate(this.node(formula), c.t));
    } catch (e) {
      v = err("#VALUE!", e instanceof Error ? e.message : String(e));
    } finally {
      this.busy.delete(key);
    }
    this.memo.set(key, v);
    return v;
  }

  /** A tab's values, every row. */
  values(t: number): Value[][] {
    const cols = this.columns(t).length;
    return Array.from({ length: this.rowCount(t) }, (_, r) => Array.from({ length: cols }, (_, c) => this.value(t, r + 1, c)));
  }

  /** The values a range names, row by row, from a tab: "A1:A6". */
  range(sheet: string | undefined, ref: string): Value[] | SheetError {
    const node = parseFormula(ref);
    const t = this.tabIndex(sheet);
    if (t < 0) return err("#REF!", `there is no tab "${sheet}"`);
    if (node.k === "range" || node.k === "ref") {
      const v = this.evaluate(node, t);
      return Array.isArray(v) ? [...v] : [v];
    }
    return err("#REF!", `"${ref}" is not a range`);
  }

  private pivot(t: number): { columns: SheetColumn[]; rows: Value[][] } {
    const got = this.pivots.get(t);
    if (got) return got;
    const tab = this.book.sheets[t]!;
    const spec = tab.pivot!;
    const empty = { columns: tab.columns, rows: [] };
    const from = this.tabIndex(spec.from);
    if (from < 0 || from === t || this.book.sheets[from]?.pivot) {
      this.pivots.set(t, empty);
      return empty;
    }
    // Held while it is worked out, so a formula reading this pivot from its own source sees nothing, not a loop.
    this.pivots.set(t, empty);
    const src = this.book.sheets[from]!;
    const by = findColumn(src.columns, spec.by);
    const vals = spec.values.map((v) => ({ ...v, i: findColumn(src.columns, v.column) }));
    const groups = new Map<string, { label: Value; rows: Value[][] }>();
    const all = this.values(from);
    for (const row of all) {
      const label = by >= 0 ? row[by]! : null;
      const key = toText(label).trim().toLowerCase();
      const g = groups.get(key) ?? { label, rows: [] };
      g.rows.push(row);
      groups.set(key, g);
    }
    const NAMES: Record<SheetAggregate, string> = { sum: "", average: "Average ", min: "Least ", max: "Most ", count: "Count of " };
    const derived: SheetColumn[] = [
      src.columns[by] ?? { label: spec.by },
      ...vals.map((v): SheetColumn => {
        const c = src.columns[v.i];
        const label = `${NAMES[v.fn]}${c?.label ?? v.column}`;
        return v.fn === "count" ? { label, type: "number", decimals: 0 } : { ...(c ?? {}), label };
      }),
    ];
    // What the pivot tab declares for a column (its label, its format) wins over what was worked out.
    const columns = derived.map((c, i) => ({ ...c, ...(tab.columns[i] ?? {}) }));
    const rows = [...groups.values()].map((g) => [g.label, ...vals.map((v) => (v.i < 0 ? err("#REF!", `no column "${v.column}"`) : aggregate(v.fn, g.rows.map((r) => r[v.i]!))))]);
    rows.sort((a, b) => {
      const x = typeof a[1] === "number" ? a[1] : -Infinity;
      const y = typeof b[1] === "number" ? b[1] : -Infinity;
      return y - x;
    });
    const out = { columns, rows };
    this.pivots.set(t, out);
    return out;
  }

  private scalar(v: Arg): Value {
    if (!Array.isArray(v)) return v;
    return v.length === 1 ? v[0]! : err("#VALUE!", "a range where one value was wanted");
  }

  private evaluate(node: Node, t: number): Arg {
    switch (node.k) {
      case "num":
      case "str":
      case "bool":
        return node.v;
      case "bad":
        return err("#NAME?", node.why);
      case "ref": {
        const tt = node.sheet === undefined ? t : this.tabIndex(node.sheet);
        if (tt < 0) return err("#REF!", `there is no tab "${node.sheet}"`);
        return this.value(tt, node.row, node.col);
      }
      case "range": {
        const tt = node.sheet === undefined ? t : this.tabIndex(node.sheet);
        if (tt < 0) return err("#REF!", `there is no tab "${node.sheet}"`);
        const out: Cells = [];
        const lastRow = Math.min(node.row2, Math.max(this.rowCount(tt), node.row));
        if (node.col2 >= this.columns(tt).length) return err("#REF!", `column ${columnLetter(node.col2)} is outside the sheet`);
        for (let r = node.row; r <= lastRow; r++) for (let c = node.col; c <= node.col2; c++) out.push(this.value(tt, r, c));
        out.width = node.col2 - node.col + 1;
        out.height = node.row2 - node.row + 1;
        return out;
      }
      case "neg": {
        const n = toNumber(this.scalar(this.evaluate(node.x, t)));
        return isError(n) ? n : -n;
      }
      case "bin":
        return this.binary(node.op, this.scalar(this.evaluate(node.a, t)), this.scalar(this.evaluate(node.b, t)));
      case "call":
        return this.call(node.name, node.args, t);
    }
  }

  private binary(op: string, a: Value, b: Value): Value {
    if (isError(a)) return a;
    if (isError(b)) return b;
    if (op === "&") return toText(a) + toText(b);
    if (["=", "<>", "<", ">", "<=", ">="].includes(op)) {
      const c = compare(a, b);
      return op === "=" ? c === 0 : op === "<>" ? c !== 0 : op === "<" ? c < 0 : op === ">" ? c > 0 : op === "<=" ? c <= 0 : c >= 0;
    }
    const x = toNumber(a);
    const y = toNumber(b);
    if (isError(x)) return x;
    if (isError(y)) return y;
    switch (op) {
      case "+":
        return x + y;
      case "-":
        return x - y;
      case "*":
        return x * y;
      case "/":
        return y === 0 ? err("#DIV/0!", "division by zero") : x / y;
      default: {
        const r = x ** y;
        return Number.isFinite(r) ? r : err("#VALUE!", "the power is out of range");
      }
    }
  }

  private call(name: string, argNodes: Node[], t: number): Value {
    const args = (): Arg[] => argNodes.map((a) => this.evaluate(a, t));
    const numbers = (list: Arg[]): number[] | SheetError => {
      const out: number[] = [];
      for (const a of list) {
        if (Array.isArray(a)) {
          for (const v of a) {
            if (isError(v)) return v;
            if (typeof v === "number") out.push(v);
          }
        } else {
          const n = toNumber(a);
          if (isError(n)) return n;
          out.push(n);
        }
      }
      return out;
    };
    const need = (n: number, m = n): SheetError | undefined =>
      argNodes.length < n || argNodes.length > m ? err("#VALUE!", `${name} takes ${n === m ? n : `${n} to ${m}`} arguments`) : undefined;
    /** One argument as a single value, a number, a date's serial, or text. */
    const one = (i: number): Value => this.scalar(this.evaluate(argNodes[i]!, t));
    const num = (i: number): number | SheetError => toNumber(one(i));
    const date = (i: number): number | SheetError => toDate(one(i));
    const text = (i: number): string | SheetError => {
      const v = one(i);
      return isError(v) ? v : toText(v);
    };
    /** One argument as a range, a single value read as a range of one. */
    const cells = (i: number): Cells | SheetError => {
      const v = this.evaluate(argNodes[i]!, t);
      if (Array.isArray(v)) return v;
      return isError(v) ? v : Object.assign([v], { width: 1, height: 1 });
    };
    switch (name) {
      case "SUM":
      case "AVERAGE":
      case "MIN":
      case "MAX": {
        const ns = numbers(args());
        if (isError(ns)) return ns;
        if (name === "SUM") return ns.reduce((a, b) => a + b, 0);
        if (name === "AVERAGE") return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : err("#DIV/0!", "there are no numbers to average");
        if (!ns.length) return 0;
        return name === "MIN" ? Math.min(...ns) : Math.max(...ns);
      }
      case "COUNT":
        return flat(args()).filter((v) => typeof v === "number").length;
      case "COUNTA":
        return flat(args()).filter((v) => v !== null && v !== "").length;
      case "ROUND":
      case "ROUNDUP":
      case "ROUNDDOWN": {
        const bad = name === "ROUND" ? need(1, 2) : need(2);
        if (bad) return bad;
        const x = num(0);
        if (isError(x)) return x;
        const places = argNodes[1] ? num(1) : 0;
        if (isError(places)) return places;
        return roundAt(x, places, name === "ROUND" ? "half" : name === "ROUNDUP" ? "up" : "down");
      }
      case "ABS": {
        const bad = need(1);
        if (bad) return bad;
        const x = num(0);
        return isError(x) ? x : Math.abs(x);
      }
      case "IF": {
        const bad = need(2, 3);
        if (bad) return bad;
        const c = one(0);
        if (isError(c)) return c;
        if (truthy(c)) return one(1);
        return argNodes[2] ? one(2) : false;
      }
      case "CONCAT":
      case "CONCATENATE": {
        const vs = flat(args());
        const e = vs.find(isError);
        return e ?? vs.map(toText).join("");
      }
      case "SUMIF":
      case "AVERAGEIF":
      case "COUNTIF": {
        const bad = name === "COUNTIF" ? need(2) : need(2, 3);
        if (bad) return bad;
        const [rangeArg, critArg, sumArg] = args();
        const range = Array.isArray(rangeArg) ? rangeArg : [rangeArg!];
        const crit = this.scalar(critArg!);
        if (isError(crit)) return crit;
        const over = sumArg === undefined ? range : Array.isArray(sumArg) ? sumArg : [sumArg];
        const picked: number[] = [];
        let count = 0;
        range.forEach((v, i) => {
          if (!meets(v, crit)) return;
          count += 1;
          const s = over[i];
          if (typeof s === "number") picked.push(s);
        });
        if (name === "COUNTIF") return count;
        if (name === "SUMIF") return picked.reduce((a, b) => a + b, 0);
        return picked.length ? picked.reduce((a, b) => a + b, 0) / picked.length : err("#DIV/0!", "no row meets the criterion");
      }
      case "MEDIAN": {
        const ns = numbers(args());
        if (isError(ns)) return ns;
        if (!ns.length) return err("#NUM!", "there are no numbers to take the median of");
        const sorted = [...ns].sort((a, b) => a - b);
        const mid = sorted.length >> 1;
        return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
      }
      case "IFERROR": {
        const bad = need(2);
        if (bad) return bad;
        const v = one(0);
        return isError(v) ? one(1) : v;
      }
      case "TODAY":
      case "NOW":
        return need(0) ?? localIso(this.now(), name === "NOW");
      case "DATE": {
        const bad = need(3);
        if (bad) return bad;
        const parts = [num(0), num(1), num(2)];
        const e = parts.find(isError);
        if (e) return e;
        const [y, m, d] = (parts as number[]).map(Math.trunc) as [number, number, number];
        if (y < 0 || y > 9999) return err("#NUM!", `${y} is not a year a date can have`);
        const serial = serialOf(y < 1900 ? y + 1900 : y, m, d);
        return serial < 0 ? err("#NUM!", "that date is before 1900") : isoOf(serial);
      }
      case "YEAR":
      case "MONTH":
      case "DAY": {
        const bad = need(1);
        if (bad) return bad;
        const s = date(0);
        if (isError(s)) return s;
        if (s < 0) return err("#NUM!", "a date before 1900");
        const p = partsOf(s);
        return name === "YEAR" ? p.year : name === "MONTH" ? p.month : p.day;
      }
      case "DATEDIF": {
        const bad = need(3);
        if (bad) return bad;
        const [a, b, unit] = [date(0), date(1), text(2)];
        if (isError(a)) return a;
        if (isError(b)) return b;
        if (isError(unit)) return unit;
        const u = unit.trim().toUpperCase() as DateDiffUnit;
        if (!DATE_UNITS.includes(u)) return err("#NUM!", `DATEDIF's unit is one of ${DATE_UNITS.join(", ")}`);
        if (a > b) return err("#NUM!", "the start date is after the end date");
        return dateDiff(a, b, u);
      }
      case "VLOOKUP": {
        const bad = need(3, 4);
        if (bad) return bad;
        const want = one(0);
        if (isError(want)) return want;
        const table = cells(1);
        if (isError(table)) return table;
        const col = num(2);
        if (isError(col)) return col;
        const c = Math.trunc(col);
        const w = widthOf(table);
        if (c < 1) return err("#VALUE!", "VLOOKUP's column number starts at 1");
        if (c > w) return err("#REF!", `the table has ${w} column${w === 1 ? "" : "s"}, so there is no column ${c}`);
        const approx = argNodes[3] ? truthy(one(3)) : true;
        const first = table.filter((_, i) => i % w === 0);
        const at = position(want, first, approx ? 1 : 0);
        return at < 0 ? err("#N/A", `${toText(want)} is not in the table's first column`) : (table[at * w + c - 1] ?? null);
      }
      case "MATCH": {
        const bad = need(2, 3);
        if (bad) return bad;
        const want = one(0);
        if (isError(want)) return want;
        const range = cells(1);
        if (isError(range)) return range;
        const list = vector(range);
        if (!list) return err("#N/A", "MATCH looks in one row or one column");
        const type = argNodes[2] ? num(2) : 1;
        if (isError(type)) return type;
        const at = position(want, list, Math.sign(type) as 0 | 1 | -1);
        return at < 0 ? err("#N/A", `${toText(want)} is not in the range`) : at + 1;
      }
      case "INDEX": {
        const bad = need(2, 3);
        if (bad) return bad;
        const range = cells(0);
        if (isError(range)) return range;
        const w = widthOf(range);
        const h = range.height ?? Math.ceil(range.length / w);
        const first = num(1);
        if (isError(first)) return first;
        const second = argNodes[2] ? num(2) : undefined;
        if (second !== undefined && isError(second)) return second;
        let [r, c] = [Math.trunc(first), second === undefined ? undefined : Math.trunc(second)];
        // One index into a single row or column counts along it.
        if (c === undefined) {
          if (w === 1) c = 1;
          else if (h === 1) [r, c] = [1, r];
          else return err("#VALUE!", "INDEX into a table takes a row and a column");
        }
        if (r < 1 || c < 1) return err("#VALUE!", "INDEX counts rows and columns from 1");
        if (r > h || c > w) return err("#REF!", `the range is ${h} by ${w}, so there is no row ${r}, column ${c}`);
        return range[(r - 1) * w + c - 1] ?? null;
      }
      case "XLOOKUP": {
        const bad = need(3, 6);
        if (bad) return bad;
        const want = one(0);
        if (isError(want)) return want;
        const [look, back] = [cells(1), cells(2)];
        if (isError(look)) return look;
        if (isError(back)) return back;
        const list = vector(look);
        const results = vector(back);
        if (!list || !results) return err("#VALUE!", "XLOOKUP looks in one row or one column and returns from one");
        if (results.length !== list.length) return err("#VALUE!", "the lookup and return ranges are not the same size");
        const mode = argNodes[4] ? num(4) : 0;
        const search = argNodes[5] ? num(5) : 1;
        if (isError(mode)) return mode;
        if (isError(search)) return search;
        if (![0, -1, 1, 2].includes(mode)) return err("#VALUE!", "XLOOKUP's match mode is 0, -1, 1 or 2");
        if (![1, -1, 2, -2].includes(search)) return err("#VALUE!", "XLOOKUP's search mode is 1, -1, 2 or -2");
        const order = list.map((_, i) => i);
        if (search < 0) order.reverse();
        let at: number;
        if (mode === 0) at = order.find((i) => sameValue(list[i]!, want)) ?? -1;
        else if (mode === 2) {
          const re = wildcard(toText(want));
          at = order.find((i) => list[i] !== null && !isError(list[i]) && re.test(toText(list[i]!))) ?? -1;
        } else at = nearest(want, list, mode as -1 | 1, order);
        if (at >= 0) return results[at] ?? null;
        return argNodes[3] ? one(3) : err("#N/A", `${toText(want)} is not in the lookup range`);
      }
      case "TEXTJOIN": {
        if (argNodes.length < 3) return err("#VALUE!", "TEXTJOIN takes a delimiter, whether to skip empty cells, and the text");
        const delim = text(0);
        if (isError(delim)) return delim;
        const skip = one(1);
        if (isError(skip)) return skip;
        const vs = flat(argNodes.slice(2).map((a) => this.evaluate(a, t)));
        const e = vs.find(isError);
        if (e) return e;
        return vs.filter((v) => !truthy(skip) || (v !== null && v !== "")).map(toText).join(delim);
      }
      case "LEFT":
      case "RIGHT": {
        const bad = need(1, 2);
        if (bad) return bad;
        const s = text(0);
        if (isError(s)) return s;
        const n = argNodes[1] ? num(1) : 1;
        if (isError(n)) return n;
        if (n < 0) return err("#VALUE!", `${name} cannot take fewer than no characters`);
        const k = Math.trunc(n);
        return name === "LEFT" ? s.slice(0, k) : k === 0 ? "" : s.slice(-k);
      }
      case "MID": {
        const bad = need(3);
        if (bad) return bad;
        const [s, start, len] = [text(0), num(1), num(2)];
        if (isError(s)) return s;
        if (isError(start)) return start;
        if (isError(len)) return len;
        if (start < 1) return err("#VALUE!", "MID counts characters from 1");
        if (len < 0) return err("#VALUE!", "MID cannot take fewer than no characters");
        const from = Math.trunc(start) - 1;
        return s.slice(from, from + Math.trunc(len));
      }
      case "LEN":
      case "UPPER":
      case "LOWER":
      case "TRIM": {
        const bad = need(1);
        if (bad) return bad;
        const s = text(0);
        if (isError(s)) return s;
        if (name === "LEN") return s.length;
        if (name === "UPPER") return s.toUpperCase();
        if (name === "LOWER") return s.toLowerCase();
        // Spaces only, as a spreadsheet trims: none at either end, one between words.
        return s.replace(/^ +| +$/g, "").replace(/ {2,}/g, " ");
      }
      default:
        return err("#NAME?", `${name} is not a function KOS sheets know`);
    }
  }
}

/** The column a tab's totals key names: a label or a letter. */
export function totalsRow(columns: readonly SheetColumn[], totals: SheetTab["totals"], rows: readonly Value[][]): (Value | undefined)[] {
  const out: (Value | undefined)[] = columns.map(() => undefined);
  for (const [ref, fn] of Object.entries(totals ?? {})) {
    const i = findColumn(columns, ref);
    if (i >= 0) out[i] = aggregate(fn, rows.map((r) => r[i] ?? null));
  }
  return out;
}

// —— formats ——

const formatters = new Map<string, Intl.NumberFormat>();
function nf(key: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  let f = formatters.get(key);
  if (!f) {
    try {
      f = new Intl.NumberFormat("en-US", options);
    } catch {
      f = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
    }
    formatters.set(key, f);
  }
  return f;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A value as its column shows it. */
export function formatValue(v: Value, column: SheetColumn | undefined): string {
  if (v === null) return "";
  if (isError(v)) return v.error;
  const type = column?.type ?? "text";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") {
    const d = column?.decimals;
    switch (type) {
      case "currency": {
        const code = (column?.currency ?? "USD").toUpperCase();
        const digits = d ?? 2;
        return nf(`c:${code}:${digits}`, { style: "currency", currency: code, currencyDisplay: "narrowSymbol", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
      }
      case "percent": {
        const digits = d ?? 1;
        return nf(`p:${digits}`, { style: "percent", minimumFractionDigits: 0, maximumFractionDigits: digits }).format(v);
      }
      case "number":
        return d === undefined ? nf("n", { maximumFractionDigits: 2 }).format(v) : nf(`n:${d}`, { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
      case "date":
        // A serial, as date arithmetic leaves one: shown as the day it is.
        return Number.isFinite(v) && v >= 0 ? formatValue(isoOf(v), column) : String(v);
      default:
        return Number.isInteger(v) ? String(v) : nf("n", { maximumFractionDigits: 4 }).format(v);
    }
  }
  if (type === "date") {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
    if (m) return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}, ${m[1]}`;
  }
  return v;
}

/** Whether a column's values sit at the right edge, as numbers do. */
export const isNumeric = (column: SheetColumn | undefined): boolean => NUMERIC.has(column?.type ?? "text");

/** How two values sort: numbers by size, empty last, text by locale. */
export function sortValue(a: Value, b: Value): number {
  const blank = (v: Value): boolean => v === null || v === "" || isError(v);
  if (blank(a) || blank(b)) return blank(a) === blank(b) ? 0 : blank(a) ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return toText(a).localeCompare(toText(b), undefined, { numeric: true, sensitivity: "base" });
}

// —— a source tab ——

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** The query that reads a source tab's rows: its key, then each column's table column. */
export function sourceQuery(tab: SheetTab): string | undefined {
  const src = tab.source;
  if (!src || !IDENT.test(src.table) || !IDENT.test(src.key)) return undefined;
  const cols = tab.columns.map((c) => quote(c.column ?? c.label));
  const order = /^([A-Za-z_][A-Za-z0-9_]*)(\s+(asc|desc))?$/i.exec(src.orderBy?.trim() ?? "");
  return `SELECT ${quote(src.key)} AS __key, ${cols.join(", ")} FROM ${quote(src.table)}${order ? ` ORDER BY ${quote(order[1]!)}${order[3] ? ` ${order[3].toUpperCase()}` : ""}` : ""}`;
}

/** A source tab's rows from its query's answer, each in the tab's column order; a column the table lacks reads empty. */
export function sourceRows(tab: SheetTab, rows: readonly Record<string, unknown>[]): SheetCell[][] {
  return rows.map((r) =>
    tab.columns.map((c) => {
      const v = r[c.column ?? c.label];
      return v === undefined ? null : (v as SheetCell);
    }),
  );
}
