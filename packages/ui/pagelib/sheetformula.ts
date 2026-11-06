/**
 * The sheet runtime's engine, apart from the page: formulas, a workbook's
 * values, totals, pivots and number formats. Pure, so it is tested alone.
 *
 * Data rows are numbered from 1 (the header is not a row) and column A is
 * the first column. A cell is a value, or a formula starting with "=".
 * Precedence follows the common spreadsheet one: comparison, then &, then
 * + and -, then * and /, then ^, then a unary minus (so -2^2 is 4).
 */

import type { SheetAggregate, SheetBook, SheetCell, SheetColumn, SheetTab } from "@kos/shared";

export type ErrorCode = "#REF!" | "#DIV/0!" | "#NAME?" | "#VALUE!" | "#CYCLE!";

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
  return Number.isFinite(n) ? n : err("#VALUE!", `"${v}" is not a number`);
}

const toText = (v: Value): string => (v === null ? "" : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : typeof v === "number" ? String(v) : isError(v) ? v.error : v);

function compare(a: Value, b: Value): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
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

type Arg = Value | Value[];

const flat = (args: Arg[]): Value[] => args.flatMap((a) => (Array.isArray(a) ? a : [a]));

/**
 * A workbook's values. Cells are worked out when first asked for and kept,
 * pivots when first read; a formula that comes back to itself is #CYCLE!.
 */
export class Workbook {
  private readonly memo = new Map<string, Value>();
  private readonly busy = new Set<string>();
  private readonly pivots = new Map<number, { columns: SheetColumn[]; rows: Value[][] }>();
  private readonly parsed = new Map<string, Node>();

  constructor(readonly book: SheetBook) {}

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
    const key = `${t}:${row}:${col}`;
    const got = this.memo.get(key);
    if (got !== undefined) return got;
    if (this.busy.has(key)) return err("#CYCLE!", `${columnLetter(col)}${row} depends on itself`);
    const cell = rows[row - 1]![col];
    let v: Value;
    if (typeof cell === "string" && cell.startsWith("=")) {
      this.busy.add(key);
      let node = this.parsed.get(cell);
      if (!node) {
        node = parseFormula(cell);
        this.parsed.set(cell, node);
      }
      v = this.scalar(this.evaluate(node, t));
      this.busy.delete(key);
    } else {
      v = literalOf(cell, tab.columns[col]);
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
      return Array.isArray(v) ? v : [v];
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
        const out: Value[] = [];
        const lastRow = Math.min(node.row2, Math.max(this.rowCount(tt), node.row));
        if (node.col2 >= this.columns(tt).length) return err("#REF!", `column ${columnLetter(node.col2)} is outside the sheet`);
        for (let r = node.row; r <= lastRow; r++) for (let c = node.col; c <= node.col2; c++) out.push(this.value(tt, r, c));
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
      case "ROUND": {
        const bad = need(1, 2);
        if (bad) return bad;
        const [x, d] = args().map((a) => toNumber(this.scalar(a)));
        if (isError(x!)) return x;
        const places = d === undefined ? 0 : d;
        if (isError(places)) return places;
        const f = 10 ** Math.trunc(places);
        const n = x as number;
        // Half away from zero, and 2.345 is 2.35 although 2.345 * 100 is 234.49999...
        return (Math.sign(n) * Math.round(Math.abs(n) * f * (1 + Number.EPSILON))) / f;
      }
      case "ABS": {
        const bad = need(1);
        if (bad) return bad;
        const x = toNumber(this.scalar(this.evaluate(argNodes[0]!, t)));
        return isError(x) ? x : Math.abs(x);
      }
      case "IF": {
        const bad = need(2, 3);
        if (bad) return bad;
        const c = this.scalar(this.evaluate(argNodes[0]!, t));
        if (isError(c)) return c;
        const truthy = typeof c === "string" ? c !== "" : Boolean(c);
        if (truthy) return this.scalar(this.evaluate(argNodes[1]!, t));
        return argNodes[2] ? this.scalar(this.evaluate(argNodes[2], t)) : false;
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
