/**
 * kos-sheet: a spreadsheet from a workbook. The agent writes one
 * `<script type="application/json" data-sheet>` holding a SheetBook; this
 * draws it after the script: tabs, a filter, a typed grid with formulas,
 * totals, sorting, frozen header and columns, and charts from ranges.
 *
 * A tab's rows are kept with the artifact (`rows`, saved through kos.save
 * after an edit, as a new version), read live from a project table
 * (`source`, edited through the declared kos.write), or grouped from another
 * tab (`pivot`, read only). The arithmetic is sheetformula.ts in @kos/shared,
 * which the server's export reads a workbook with too.
 *
 * The owner pastes a range or imports a CSV (sheetimport.ts), which adds
 * rows and fills empty cells, and asks in a bar of its own before it
 * replaces a filled one; puts in, renames, retypes and deletes columns from
 * a column's menu and rows from their numbers (sheetshape.ts), and undoes
 * any of it. A tab over a table takes its pastes and imports as the
 * table's own inserts and updates, and changes no column: a table's columns
 * are its migrations', changed by asking KOS.
 */

import type { SheetBook, SheetCell, SheetColumn, SheetColumnType, SheetTab } from "@kos/shared";
// The one module, not the package's index, which would inline all of @kos/shared into the runtime.
import { HTML_PAGE_MAX, SHEET_ROWS_MAX } from "@kos/shared/artifacts";
import { Workbook, columnLetter, findColumn, formatValue, isError, isNumeric, literalOf, sortValue, sourceQuery, sourceRows, totalsRow, type Value } from "@kos/shared/sheetformula";

import { bar, line, pie } from "./chartdraw.js";
import { SHEET_CSS } from "./sheet.css.js";
import { importPanel, inlineBar, menu, rowDetail, TYPE_WORDS, type Action, type MenuItem } from "./sheetpanels.js";
import { autoMap, clipboardRows, coerce, decodeText, detectDelimiter, importRows, isHeader, parseDelimited, planPaste, type Delimiter, type PastePlan } from "./sheetimport.js";
import { deleteColumn, deleteRows, fillNewRows, freshLabel, insertColumn, insertRows, renameColumn, retypeColumn } from "./sheetshape.js";
import { addStyle, editable, el, hideRepeatedTitle, kos, onPhone, ready, reason } from "./runtime.js";

/** How long after an edit the workbook is saved, so a run of edits is one version. */
export const SAVE_DELAY_MS = 600;
/** The least time between two saves: KOS takes one of the owner's edits to an artifact every 2 s (PageStore's EDIT_GAP_MS). */
export const SAVE_GAP_MS = 2100;

/** How many changes back Undo reaches. */
const UNDO_MAX = 50;
/** The largest file an import reads. */
const IMPORT_BYTES_MAX = 5 * 1024 * 1024;
/** The most rows one paste or import writes into a table, a write each. */
const TABLE_ROWS_IN = 1000;
/** How many rows the import preview shows. */
const PREVIEW_ROWS = 5;

/** The shortest a grid is drawn, however little room the frame has. */
const SHEET_MIN_HEIGHT = 320;
/** The shortest it is drawn under an open panel, which then keeps a few rows in view. */
const SHEET_PANEL_MIN_HEIGHT = 180;
/** Where the stylesheet's phone layout starts (sheet.css.ts). */
const PHONE_QUERY = "(max-width: 560px)";
/** The most fields a row opened on a phone carries, and the most characters of each. */
export const ROW_FIELDS_MAX = 200;
export const ROW_VALUE_MAX = 2000;

/**
 * The column a phone holds at the grid's right edge while there is more to
 * see: the first figure the tab totals, else its first currency, never a
 * frozen one; -1 when there is none. A phone cut the amount of an expense
 * sheet off at its edge, and the row read as having none.
 */
export function keyColumn(columns: readonly SheetColumn[], totals: SheetTab["totals"], freeze: number): number {
  const totalled = new Set(Object.keys(totals ?? {}).map((ref) => findColumn(columns, ref)));
  const figure = columns.findIndex((c, i) => i >= freeze && isNumeric(c) && totalled.has(i));
  return figure >= 0 ? figure : columns.findIndex((c, i) => i >= freeze && c.type === "currency");
}

/** A row opened on a phone, as the sheet tells the app around it, which draws it as a sheet of its own. */
export interface RowReport {
  __kos: "row";
  sheet: string;
  title: string;
  fields: { label: string; value: string; numeric: boolean }[];
}

/**
 * A row with every field labelled, each value as the grid shows it. The row
 * is named by its first column, or by its number when that is empty; what is
 * past the caps is cut, so one row never floods the app.
 */
export function rowReport(sheet: string, columns: readonly SheetColumn[], row: readonly Value[], n: number): RowReport {
  const cut = (text: string): string => text.slice(0, ROW_VALUE_MAX);
  const fields = columns.slice(0, ROW_FIELDS_MAX).map((c, i) => ({ label: cut(c.label), value: cut(formatValue(row[i] ?? null, c)), numeric: isNumeric(c) }));
  return { __kos: "row", sheet: cut(sheet), title: fields[0]?.value || `Row ${n}`, fields };
}

/** What an owner typed, as a cell to store: a formula stays one, a value is read by the column's type as a paste is (a date into ISO), and what does not fit stays as typed. */
export function cellFromInput(text: string, column: SheetColumn | undefined): SheetCell {
  const t = text.trim();
  if (t === "") return null;
  if (t.startsWith("=")) return t;
  const got = coerce(t, column);
  return "cell" in got ? got.cell : t;
}

/** The rows of a view: filtered by text in one column or any, then sorted, as data row numbers (from 1). */
export function viewRows(values: Value[][], columns: readonly SheetColumn[], filter: { text: string; column: number }, sort: { column: number; dir: 1 | -1 } | undefined): number[] {
  const needle = filter.text.trim().toLowerCase();
  let rows = values.map((_, i) => i + 1);
  if (needle) {
    rows = rows.filter((r) => {
      const row = values[r - 1]!;
      const cells = filter.column >= 0 ? [filter.column] : row.map((_, c) => c);
      return cells.some((c) => formatValue(row[c] ?? null, columns[c]).toLowerCase().includes(needle));
    });
  }
  if (sort) rows.sort((a, b) => sort.dir * sortValue(values[a - 1]![sort.column] ?? null, values[b - 1]![sort.column] ?? null) || a - b);
  return rows;
}

interface Loaded {
  keys: unknown[];
  rows: SheetCell[][];
  error?: string;
}

/** A CSV being imported: the file, how it is read, and which of its fields fills each column. */
interface Importing {
  file: string;
  text: string;
  delimiter: Delimiter;
  header: boolean;
  map: number[];
}

/**
 * About how long the stored page would be holding this workbook: the data as
 * a save writes it (a "<" escaped to six characters), and the rest of the
 * agent's markup as the frame holds it. KOS keeps an artifact to
 * HTML_PAGE_MAX, so rows past that could be shown but never saved.
 */
function pageSize(book: SheetBook): number {
  const data = JSON.stringify(book).replace(/</g, "\\u003c").length;
  const rest = [...document.body.children].filter((n) => !n.hasAttribute("data-kos-gen") && !n.matches("script[data-sheet]")).reduce((n, e) => n + e.outerHTML.length, 0);
  return data + rest;
}

/** Why rows cannot be added to a tab kept with the artifact, when they would make it too long to save. */
function tooLong(book: SheetBook, t: number, added: readonly SheetCell[][]): string | undefined {
  const next = { ...book, sheets: book.sheets.map((s, i) => (i === t ? { ...s, rows: [...(s.rows ?? []), ...added] } : s)) };
  const size = pageSize(next);
  if (size <= HTML_PAGE_MAX) return undefined;
  return `These rows would make the sheet about ${Math.ceil(size / 1000)} KB, past the ${HTML_PAGE_MAX / 1000} KB an artifact keeps, so they could not be saved. Rows this many belong in a project table, which a tab reads with source.`;
}

/** One write in a batch to a table. */
type TableWrite = { table: string; op: "insert" | "update" | "delete"; values?: Record<string, unknown>; key?: { column: string; value: unknown } };

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

class Sheet {
  private tab = 0;
  private sort: { column: number; dir: 1 | -1 } | undefined;
  private filter = { text: "", column: -1 };
  private focus = { row: 1, col: 0 };
  private loaded = new Map<number, Loaded>();
  private wb: Workbook;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private savedAt = -Infinity;
  private readonly root = el("div", { class: "sheet" });
  private readonly status = el("span", { class: "sheet-status", role: "status", "aria-live": "polite" });
  private resizeWatch: ResizeObserver | undefined;
  /** The sheet's content width as its observer last saw it, which a chart's layout depends on. */
  private chartsAt = 0;
  /** The frame a resize waits for before it redraws, and the width it saw last. */
  private resizeFrame = 0;
  private resizeAt = 0;
  /** The bar or the import preview under the tools, while the owner decides. */
  private panel: HTMLElement | undefined;
  private importing: Importing | undefined;
  /** The column menu open now, and what closes it. */
  private menuOpen: { box: HTMLElement; close: () => void } | undefined;
  /** The workbook before each change the owner made to it here, newest last. */
  private undos: { book: string; tab: number }[] = [];
  /** The rows picked by their numbers, and the one a shift-press runs from. */
  private picked = new Set<number>();
  private pickedFrom: number | undefined;
  /** For a tab over a table, each picked row's key as it was when picked, which a delete names. */
  private pickedKeys = new Map<number, unknown>();

  constructor(
    private readonly book: SheetBook,
    anchor: Element,
  ) {
    anchor.after(this.root);
    this.wb = this.workbook();
    this.book.sheets.forEach((t, i) => {
      if (t.source) void this.load(i);
    });
    if (typeof ResizeObserver === "function") {
      // The charts follow the width the observer sees, so a change of height alone never redraws them; drawn before the sheet was laid out, they are drawn again once it is.
      this.resizeWatch = new ResizeObserver(([e]) => {
        this.resizeAt = Math.round(e?.contentRect.width ?? 0);
        // Redrawn on the next frame, outside the observer's callback: a redraw changes the sheet's height, which the observer would otherwise have to report again in the same frame.
        if (this.resizeFrame) return;
        this.resizeFrame = (globalThis.requestAnimationFrame ?? setTimeout)(() => {
          this.resizeFrame = 0;
          if (this.resizeAt !== 0 && this.resizeAt !== this.chartsAt) {
            this.chartsAt = this.resizeAt;
            this.drawCharts();
          }
          this.markHeld();
        }) as unknown as number;
      });
      this.resizeWatch.observe(this.root);
    }
    // The phone's tighter cells move where each frozen column starts; it has no column picker, so its filter is in any.
    globalThis.matchMedia?.(PHONE_QUERY)?.addEventListener("change", (e) => {
      if (e.matches && this.filter.column >= 0) {
        this.filter.column = -1;
        this.render();
      } else this.pin();
    });
    addEventListener("resize", () => this.fit());
    this.root.addEventListener("paste", (e) => this.paste(e));
    this.render();
  }

  /**
   * The grid takes what is left of the frame below the sheet's head and tools,
   * so in the dashboard only the grid scrolls, never the frame around it. A
   * page of several sheets, or one with charts under its grid, keeps the
   * stylesheet's height and scrolls as a page.
   */
  private fit(): void {
    const scroll = this.root.querySelector<HTMLElement>(".sheet-scroll");
    if (!scroll || this.book.charts?.length || document.querySelectorAll(".sheet").length > 1) return;
    const pad = parseFloat(getComputedStyle(document.body).paddingBottom) || 0;
    const room = Math.floor(innerHeight - (scroll.getBoundingClientRect().top + scrollY) - pad - 2);
    // While a panel asks something, the grid may be shorter, so the frame stays one view tall around both.
    this.root.style.setProperty("--sheet-height", `${Math.max(this.panel ? SHEET_PANEL_MIN_HEIGHT : SHEET_MIN_HEIGHT, room)}px`);
  }

  /** The workbook as it is evaluated: source tabs carry the rows read for them. */
  private workbook(): Workbook {
    return new Workbook({ ...this.book, sheets: this.book.sheets.map((t, i) => (t.source ? { ...t, rows: this.loaded.get(i)?.rows ?? [] } : t)) });
  }

  private async load(i: number): Promise<void> {
    const tab = this.book.sheets[i]!;
    const sql = sourceQuery(tab);
    const bridge = kos();
    if (!sql || !bridge) {
      this.loaded.set(i, { keys: [], rows: [], error: sql ? "This sheet reads a table through KOS, which is not here." : "The tab's source needs a plain table and key name." });
    } else {
      try {
        const res = await bridge.query(sql);
        this.loaded.set(i, {
          keys: res.rows.map((r) => r.__key),
          rows: sourceRows(tab, res.rows),
        });
      } catch (e) {
        this.loaded.set(i, { keys: [], rows: [], error: reason(e) });
      }
    }
    // Rows read again may stand in other places: nothing picked or planned on the ones before carries over.
    if (i === this.tab) {
      this.picked.clear();
      this.pickedKeys.clear();
      this.panel = undefined;
      this.importing = undefined;
    }
    this.wb = this.workbook();
    this.render();
  }

  private say(text: string, bad = false): void {
    this.status.textContent = text;
    this.status.classList.toggle("bad", bad);
  }

  private editable(t: number): boolean {
    const tab = this.book.sheets[t]!;
    if (tab.pivot) return false;
    if (tab.source) return typeof kos()?.write === "function" && !this.loaded.get(t)?.error;
    return editable();
  }

  /** Draw the tab. A tab that cannot be drawn says why, under its tabs, rather than leave the sheet blank. */
  private render(): void {
    try {
      this.draw();
      this.fit();
    } catch (e) {
      this.root.replaceChildren(...this.tabBar(), el("p", { class: "sheet-error", role: "alert" }, `This tab could not be drawn: ${reason(e)}`));
    }
  }

  /** The tabs to switch between, when there is more than one. */
  private tabBar(): Node[] {
    const tabs = this.book.sheets;
    if (tabs.length < 2) return [];
    const list = el("div", { class: "sheet-tabs", role: "tablist" });
    tabs.forEach((s, i) => {
      const b = el("button", { type: "button", role: "tab", "aria-selected": String(i === this.tab) }, s.name);
      b.addEventListener("click", () => {
        this.tab = i;
        this.sort = undefined;
        this.filter = { text: "", column: -1 };
        this.focus = { row: 1, col: 0 };
        this.picked.clear();
        this.panel = undefined;
        this.importing = undefined;
        this.render();
      });
      list.append(b);
    });
    return [list];
  }

  private draw(): void {
    const t = this.tab;
    const tab = this.book.sheets[t]!;
    const columns = this.wb.columns(t);
    const values = this.wb.values(t);
    const rows = viewRows(values, columns, this.filter, this.sort);
    const parts: Node[] = [...this.tabBar()];

    const search = el("input", { type: "search", placeholder: "Filter rows", "aria-label": "Filter rows", value: this.filter.text });
    search.value = this.filter.text;
    search.addEventListener("input", () => {
      this.filter.text = search.value;
      this.renderGrid();
    });
    const which = el("select", { "aria-label": "Filter in" }, el("option", { value: "-1" }, "All columns"), ...columns.map((c, i) => el("option", { value: String(i) }, c.label)));
    which.value = String(this.filter.column);
    which.addEventListener("change", () => {
      this.filter.column = Number(which.value);
      this.renderGrid();
    });
    const tools = el("div", { class: "sheet-tools" }, search, which, el("span", { class: "sheet-rows" }), el("span", { class: "sheet-spacer" }), this.status);
    const tool = (label: string, run: () => void): void => {
      const b = el("button", { type: "button" }, label);
      b.addEventListener("click", run);
      tools.append(b);
    };
    const undo = this.undos.at(-1);
    if (undo && editable()) {
      tool("Undo", () => this.undo());
      // The workbook goes back as a whole, so the button says which tab its change was in when it is not this one.
      const where = undo.tab !== t ? ` (in ${this.book.sheets[undo.tab]?.name ?? "another tab"})` : "";
      tools.lastElementChild!.setAttribute("title", `Undo the last change${where}`);
      if (where) tools.lastElementChild!.textContent = `Undo${where}`;
    }
    if (tab.rows && this.editable(t)) tool("Add row", () => this.addRow());
    if (!tab.pivot && this.editable(t)) tool("Import CSV", () => this.pickFile());
    parts.push(tools);
    if (this.picked.size && this.editable(t)) parts.push(this.rowBar());
    if (this.panel) parts.push(this.panel);
    const err = this.loaded.get(t)?.error;
    if (err) parts.push(el("p", { class: "sheet-error", role: "alert" }, `The rows could not be read: ${err}`));
    const scroll = el("div", { class: "sheet-scroll" });
    scroll.addEventListener("scroll", () => this.markHeld(), { passive: true });
    parts.push(scroll);
    if (this.book.charts?.length) parts.push(el("div", { class: "sheet-charts" }));
    this.root.replaceChildren(...parts);
    this.renderGrid(rows);
    this.drawCharts();
  }

  private renderGrid(given?: number[]): void {
    const t = this.tab;
    const tab = this.book.sheets[t]!;
    const columns = this.wb.columns(t);
    const values = this.wb.values(t);
    const rows = given ?? viewRows(values, columns, this.filter, this.sort);
    const freeze = Math.max(0, Math.min(tab.freeze ?? 0, columns.length));
    // A phone always holds the first column, the row's name, beside the row numbers.
    const key = keyColumn(columns, tab.totals, Math.max(1, freeze));
    const kinds = (c: SheetColumn, i: number): (string | false)[] => [isNumeric(c) && "num", i === 0 && "lead", i === key && "key", i < freeze && "frozen", i === freeze - 1 && "frozen-edge"];
    const count = this.root.querySelector(".sheet-rows");
    if (count) count.textContent = rows.length === values.length ? `${values.length} rows` : `${rows.length} of ${values.length} rows`;

    const headRow = el("tr", {}, el("th", { class: "rownum", scope: "col", "aria-label": "Row" }, ""));
    const shaping = !tab.pivot && editable();
    const picking = !tab.pivot && this.editable(t);
    columns.forEach((c, i) => {
      const dir = this.sort?.column === i ? (this.sort.dir === 1 ? "ascending" : "descending") : "none";
      const b = el("button", { type: "button", title: `Sort by ${c.label}` }, el("span", { class: "letter" }, columnLetter(i)), el("span", { class: "name" }, c.label));
      b.addEventListener("click", () => {
        this.sort = this.sort?.column !== i ? { column: i, dir: 1 } : this.sort.dir === 1 ? { column: i, dir: -1 } : undefined;
        this.renderGrid();
      });
      const th = el("th", { scope: "col", "aria-sort": dir, class: cls(...kinds(c, i)) }, b);
      if (shaping) {
        const more = el("button", { type: "button", class: "sheet-colmenu", "aria-label": `${c.label}: column menu`, "aria-haspopup": "menu" }, "\u22EF");
        more.addEventListener("click", (e) => {
          e.stopPropagation();
          this.columnMenu(i, more);
        });
        th.append(more);
      }
      // A width the stylesheet keeps on a desktop and lets go of on a phone.
      if (c.width) th.style.setProperty("--sheet-col", `${c.width}ch`);
      headRow.append(th);
    });

    const body = el("tbody");
    for (const r of rows) {
      const num = picking ? el("button", { type: "button", class: "pick", tabindex: "-1", "aria-pressed": String(this.picked.has(r)), "aria-label": `Row ${r}` }, String(r)) : String(r);
      if (typeof num !== "string") num.addEventListener("click", (e) => this.pick(r, rows, { run: e.shiftKey, add: e.metaKey || e.ctrlKey }));
      const tr = el("tr", { class: this.picked.has(r) ? "picked" : undefined, "data-row": String(r) }, el("th", { class: "rownum", scope: "row" }, num));
      columns.forEach((c, i) => tr.append(this.cell(t, r, i, values[r - 1]![i] ?? null, c, kinds(c, i))));
      tr.addEventListener("click", (e) => {
        if (this.opensRow(e.target)) this.openRow(r);
      });
      body.append(tr);
    }
    const table = el("table", { class: "sheet-grid", role: "grid", "aria-label": tab.name, "aria-rowcount": String(rows.length + 1) }, el("thead", {}, headRow), body);
    if (!rows.length) {
      const span = String(columns.length + 1);
      body.append(el("tr", {}, el("td", { class: "sheet-empty", colspan: span }, values.length ? "No rows match the filter." : this.loaded.has(t) || !tab.source ? "No rows yet." : "Reading the rows…")));
    }
    if (tab.totals && Object.keys(tab.totals).length && rows.length) {
      const shown = rows.map((r) => values[r - 1]!);
      const sums = totalsRow(columns, tab.totals, shown);
      const label = rows.length === values.length ? "Total" : "Shown";
      // A phone draws the word as a sigma, so the row numbers' column is no wider than its numbers.
      const tr = el("tr", {}, el("th", { class: "rownum", scope: "row", "aria-label": label, title: label }, el("span", { class: "word" }, label)));
      columns.forEach((c, i) => {
        const v = sums[i];
        tr.append(el("td", { class: cls(...kinds(c, i), v !== undefined && isError(v) && "err") }, v === undefined ? "" : formatValue(v, c)));
      });
      table.append(el("tfoot", {}, tr));
    }
    table.addEventListener("keydown", (e) => this.key(e));
    const scroll = this.root.querySelector(".sheet-scroll")!;
    scroll.replaceChildren(table);
    (globalThis.requestAnimationFrame ?? setTimeout)(() => {
      this.pin();
      this.markHeld();
    });
  }

  /**
   * Mark the key column held at the grid's right edge while more of the row
   * runs past it, so its shadow says what slides under it, and the grid at
   * its start, where nothing slides under the first column yet. A phone cut
   * the amount of a row off at its edge, and the row read as having none.
   */
  private markHeld(): void {
    const scroll = this.root.querySelector<HTMLElement>(".sheet-scroll");
    const key = scroll?.querySelector(".sheet-grid thead th.key")?.getBoundingClientRect();
    if (!scroll) return;
    const more = Math.ceil(scroll.scrollLeft + scroll.clientWidth) < scroll.scrollWidth - 1;
    const right = scroll.getBoundingClientRect().left + scroll.clientLeft + scroll.clientWidth;
    scroll.classList.toggle("held", more && !!key && key.right >= right - 1);
    scroll.classList.toggle("at-start", scroll.scrollLeft <= 0);
  }

  /**
   * Whether a press on a row opens it with every field labelled: anywhere on
   * a phone, where the grid only reads; at a narrow width, anywhere on a row
   * the owner cannot edit here, else only on its first column, so a press on
   * any other cell still picks it to type in.
   */
  private opensRow(target: EventTarget | null): boolean {
    if (!(target instanceof Element) || target.closest("button, input")) return false;
    if (onPhone()) return true;
    if (!globalThis.matchMedia?.(PHONE_QUERY)?.matches) return false;
    return !this.editable(this.tab) || target.closest("td.lead") !== null;
  }

  /** Open a row: told to the phone's app, which draws it, else drawn here, over the grid's foot. */
  private openRow(r: number): void {
    const report = rowReport(this.book.sheets[this.tab]!.name, this.wb.columns(this.tab), this.wb.values(this.tab)[r - 1] ?? [], r);
    if (onPhone()) return top?.postMessage(report, "*");
    this.root.querySelector(":scope > .sheet-detail")?.remove();
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const box = rowDetail(report, () => {
      box.remove();
      back?.focus({ preventScroll: true });
    });
    this.root.append(box);
    box.querySelector<HTMLButtonElement>("button")?.focus();
  }

  /** Pin the frozen columns of the grid drawn now, at the widths it has now. */
  private pin(): void {
    const table = this.root.querySelector<HTMLTableElement>(".sheet-grid");
    if (table) pinColumns(table);
  }

  private cell(t: number, row: number, col: number, v: Value, column: SheetColumn, kinds: (string | false)[]): HTMLTableCellElement {
    const raw = this.rawCell(t, row, col);
    const formula = typeof raw === "string" && raw.startsWith("=");
    const isFocus = this.focus.row === row && this.focus.col === col;
    const td = el(
      "td",
      {
        class: cls(...kinds, isError(v) && "err", typeof v === "boolean" && "bool", formula && "formula", isFocus && "focus"),
        tabindex: isFocus ? "0" : "-1",
        "data-row": String(row),
        "data-col": String(col),
        title: isError(v) ? `${v.error} ${v.why}` : formula ? raw : undefined,
      },
      typeof v === "boolean" ? (v ? "✓" : "") : formatValue(v, column),
    );
    if (typeof v === "boolean") td.setAttribute("aria-label", v ? "Yes" : "No");
    td.addEventListener("click", () => this.moveTo(row, col));
    td.addEventListener("dblclick", () => this.edit(td));
    return td;
  }

  private rawCell(t: number, row: number, col: number): SheetCell {
    const tab = this.book.sheets[t]!;
    const rows = tab.source ? this.loaded.get(t)?.rows : tab.rows;
    return rows?.[row - 1]?.[col] ?? null;
  }

  private cellAt(row: number, col: number): HTMLTableCellElement | null {
    return this.root.querySelector<HTMLTableCellElement>(`td[data-row="${row}"][data-col="${col}"]`);
  }

  private moveTo(row: number, col: number): void {
    const next = this.cellAt(row, col);
    if (!next) return;
    this.root.querySelectorAll("td.focus").forEach((n) => {
      n.classList.remove("focus");
      n.setAttribute("tabindex", "-1");
    });
    next.classList.add("focus");
    next.setAttribute("tabindex", "0");
    next.focus({ preventScroll: false });
    this.focus = { row, col };
  }

  private key(e: KeyboardEvent): void {
    const td = (e.target as Element).closest?.("td[data-row]") as HTMLTableCellElement | null;
    if (!td || td.classList.contains("editing")) return;
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
      e.preventDefault();
      return this.undo();
    }
    // Shift+Space picks the focused cell's row, or lets it go, as a press on its number with Cmd does.
    if (e.key === " " && e.shiftKey && !this.book.sheets[this.tab]!.pivot && this.editable(this.tab)) {
      e.preventDefault();
      return this.pick(Number(td.dataset.row), this.shownRows(), { run: false, add: true });
    }
    const row = Number(td.dataset.row);
    const col = Number(td.dataset.col);
    const visible = [...this.root.querySelectorAll<HTMLTableCellElement>(`td[data-col="${col}"]`)].map((n) => Number(n.dataset.row));
    const at = visible.indexOf(row);
    const move = (r: number | undefined, c: number): void => {
      if (r === undefined) return;
      e.preventDefault();
      this.moveTo(r, Math.max(0, Math.min(this.wb.columns(this.tab).length - 1, c)));
    };
    switch (e.key) {
      case "ArrowDown":
        return move(visible[Math.min(at + 1, visible.length - 1)], col);
      case "ArrowUp":
        return move(visible[Math.max(at - 1, 0)], col);
      case "ArrowRight":
        return move(row, col + 1);
      case "ArrowLeft":
        return move(row, col - 1);
      case "Enter":
      case "F2":
        e.preventDefault();
        if (!this.editable(this.tab) && this.opensRow(td)) return this.openRow(row);
        return this.edit(td);
      case "Delete":
      case "Backspace":
        if (!this.editable(this.tab)) return;
        e.preventDefault();
        return void this.commit(row, col, "");
      default:
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && this.editable(this.tab)) {
          e.preventDefault();
          this.edit(td, e.key);
        }
    }
  }

  private edit(td: HTMLTableCellElement, typed?: string): void {
    if (!this.editable(this.tab) || td.classList.contains("editing")) return;
    const row = Number(td.dataset.row);
    const col = Number(td.dataset.col);
    const raw = this.rawCell(this.tab, row, col);
    const input = el("input", { type: "text", "aria-label": `${columnLetter(col)}${row}` });
    input.value = typed ?? (raw === null ? "" : String(raw));
    if (input.value.startsWith("=")) input.classList.add("formula");
    td.classList.add("editing");
    td.replaceChildren(input);
    input.focus();
    if (typed === undefined) input.select();
    let done = false;
    const finish = (save: boolean, then?: { row: number; col: number }): void => {
      if (done) return;
      done = true;
      if (save) void this.commit(row, col, input.value, then);
      else {
        this.renderGrid();
        this.moveTo(row, col);
      }
    };
    input.addEventListener("input", () => input.classList.toggle("formula", input.value.startsWith("=")));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true, { row: row + 1, col });
      } else if (e.key === "Tab") {
        e.preventDefault();
        finish(true, { row, col: col + (e.shiftKey ? -1 : 1) });
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
      e.stopPropagation();
    });
    input.addEventListener("blur", () => finish(true));
  }

  private async commit(row: number, col: number, text: string, then?: { row: number; col: number }): Promise<void> {
    const t = this.tab;
    const tab = this.book.sheets[t]!;
    const column = tab.columns[col];
    const cell = cellFromInput(text, column);
    const before = this.rawCell(t, row, col);
    const after = (): void => {
      this.wb = this.workbook();
      this.render();
      const target = then && this.cellAt(then.row, then.col) ? then : { row, col };
      this.moveTo(target.row, target.col);
    };
    if (cell === before) return after();
    if (tab.source) {
      const loaded = this.loaded.get(t)!;
      const name = column?.column ?? column?.label ?? "";
      try {
        this.say("Saving…");
        const got = (await kos()!.write(tab.source.table, "update", { [name]: cell }, { column: tab.source.key, value: loaded.keys[row - 1] })) as { changes?: number } | undefined;
        loaded.rows[row - 1]![col] = cell;
        if (got?.changes === 0) this.say("Not saved: that row is already gone from the table", true);
        else this.say("Saved");
        await this.load(t);
      } catch (e) {
        this.say(`Not saved: ${reason(e)}`, true);
      }
      return after();
    }
    this.keepUndo();
    // A bar's plan counted the cells as they were; an import only appends, so its preview stands.
    if (!this.importing) this.panel = undefined;
    const rows = tab.rows!;
    while (rows.length < row) rows.push(tab.columns.map(() => null));
    const r = rows[row - 1]!;
    while (r.length < tab.columns.length) r.push(null);
    r[col] = cell;
    this.scheduleSave();
    after();
  }

  private addRow(): void {
    const tab = this.book.sheets[this.tab]!;
    this.keepUndo();
    tab.rows!.push(...fillNewRows(tab.rows!, [tab.columns.map(() => null)], tab.rows!.length + 1, tab.columns.length));
    this.filter.text = "";
    this.sort = undefined;
    this.wb = this.workbook();
    this.render();
    this.moveTo(tab.rows!.length, 0);
    this.scheduleSave();
  }

  private scheduleSave(): void {
    const save = kos()?.save;
    if (!save) return;
    clearTimeout(this.saveTimer);
    this.say("Unsaved changes");
    this.saveTimer = setTimeout(() => {
      this.say("Saving…");
      this.savedAt = Date.now();
      save({ sheet: this.book }).then(
        () => this.say("Saved"),
        (e: unknown) => this.say(`Not saved: ${reason(e)}`, true),
      );
    }, Math.max(SAVE_DELAY_MS, this.savedAt + SAVE_GAP_MS - Date.now()));
  }

  /** The workbook worked out again and drawn. */
  private redraw(): void {
    this.wb = this.workbook();
    this.render();
  }

  /** Keep the workbook as it is now, so the change about to be made can be undone. */
  private keepUndo(): void {
    this.undos.push({ book: JSON.stringify(this.book), tab: this.tab });
    if (this.undos.length > UNDO_MAX) this.undos.shift();
  }

  /** Drop what was worked out on the workbook as it was: a bar's plan, an import's preview, the picked rows. A change moves the cells they name. */
  private forgetPending(): void {
    this.panel = undefined;
    this.importing = undefined;
    this.picked.clear();
    this.pickedKeys.clear();
  }

  /** Change the workbook kept with the artifact, undoably: worked out, drawn and saved, anything pending on it dropped. */
  private change(fn: () => void): void {
    this.forgetPending();
    this.keepUndo();
    fn();
    this.redraw();
    this.scheduleSave();
  }

  /** The workbook as it was before the last change made here, whichever tab it was in, saved as the next version. A table's rows are the table's, and are not undone. */
  private undo(): void {
    const last = this.undos.pop();
    if (!last || !editable()) return;
    const was = JSON.parse(last.book) as SheetBook;
    // Shown on the tab its change was made in, so what goes back is in view.
    if (last.tab !== this.tab) {
      this.tab = last.tab;
      this.filter = { text: "", column: -1 };
      this.focus = { row: 1, col: 0 };
    }
    this.book.sheets.splice(0, this.book.sheets.length, ...was.sheets);
    if (was.charts) this.book.charts = was.charts;
    else delete this.book.charts;
    this.forgetPending();
    this.sort = undefined;
    this.redraw();
    this.scheduleSave();
    this.moveTo(this.focus.row, this.focus.col);
  }

  /** Show a bar or the import preview under the tools, or none; focus goes to what was focused in it before (by its label), else its first choice. */
  private show(panel: HTMLElement | undefined, keep?: string | null): void {
    this.panel = panel;
    this.root.querySelector(":scope > .sheet-panel")?.remove();
    if (panel) this.root.querySelector(":scope > .sheet-scroll")?.before(panel);
    // The grid takes what the panel leaves, or has back.
    this.fit();
    if (!panel) return;
    const controls = [...panel.querySelectorAll<HTMLElement>("button, select, input")];
    const again = keep ? controls.find((c) => c.getAttribute("aria-label") === keep) : undefined;
    (again ?? controls.find((c) => c.matches("button.primary, button.danger")) ?? controls[0])?.focus();
  }

  /** Close the bar and give the grid its focus back. */
  private dismiss(): void {
    this.show(undefined);
    this.moveTo(this.focus.row, this.focus.col);
  }

  private dismissal(): Action {
    return { label: "Dismiss", run: () => this.dismiss() };
  }

  /** The data rows the grid shows now, in its order. */
  private shownRows(): number[] {
    return viewRows(this.wb.values(this.tab), this.wb.columns(this.tab), this.filter, this.sort);
  }

  private planFor(block: string[][], targets: readonly number[], col: number): PastePlan {
    const t = this.tab;
    return planPaste(block, targets, col, this.book.sheets[t]!.columns, (r, c) => this.rawCell(t, r, c));
  }

  private pasteNotes(plan: PastePlan): string[] {
    return [...plan.errors, ...(plan.dropped ? [`${plural(plan.dropped, "pasted column")} past the last ${plan.dropped === 1 ? "was" : "were"} left out.`] : [])];
  }

  /**
   * A range pasted from a spreadsheet, laid from the focused cell down the
   * rows as shown, adding rows past the last. Empty cells take it at once;
   * a paste that would replace filled ones asks first, offering to add its
   * rows instead. Pasted into a cell being typed in, or the filter, it is
   * that input's.
   */
  private paste(e: ClipboardEvent): void {
    if ((e.target as Element | null)?.closest?.("input, select, textarea")) return;
    const t = this.tab;
    if (this.book.sheets[t]!.pivot || !this.editable(t) || !e.clipboardData) return;
    const block = clipboardRows(e.clipboardData.getData("text/plain"), e.clipboardData.getData("text/html"));
    if (!block.length) return;
    e.preventDefault();
    const shown = this.shownRows();
    const from = shown.indexOf(this.focus.row);
    const col = this.focus.col;
    const plan = this.planFor(block, from < 0 ? [] : shown.slice(from), col);
    // A table's keys as they are now, which the writes name, however the rows are read again before a choice.
    const keys = [...(this.loaded.get(t)?.keys ?? [])];
    if (!plan.replaces) return void this.applyPaste(plan, keys);
    const asRows = this.planFor(block, [], col);
    this.show(
      inlineBar(`This paste would replace ${plural(plan.replaces, "filled cell")}.`, this.pasteNotes(plan), [
        { label: "Replace", tone: "primary", run: () => void this.applyPaste(plan, keys) },
        { label: asRows.added.length === 1 ? "Add as a new row" : `Add as ${asRows.added.length} new rows`, run: () => void this.applyPaste(asRows, keys) },
        { label: "Cancel", run: () => this.dismiss() },
      ]),
    );
  }

  private async applyPaste(plan: PastePlan, keys: readonly unknown[]): Promise<void> {
    const t = this.tab;
    const notes = this.pasteNotes(plan);
    const said = [plan.cells.length && plural(plan.cells.length, "cell"), plan.added.length && plural(plan.added.length, "new row")].filter(Boolean).join(" and ");
    if (!said) return this.show(inlineBar("Nothing in the paste fits this tab.", notes, [this.dismissal()]));
    this.panel = undefined;
    const done = this.book.sheets[t]!.source ? await this.writeTable(t, plan.cells, plan.added, keys) : this.keepRows(t, plan.cells, plan.added);
    if (!done) return;
    const first = plan.cells[0];
    if (first) this.moveTo(first.row, first.col);
    if (notes.length) this.show(inlineBar(`Pasted ${said}.`, notes, [this.dismissal()]));
  }

  /** Set cells and add rows in a tab kept with the artifact, as one change; refused past the rows a tab holds. */
  private keepRows(t: number, cells: PastePlan["cells"], added: SheetCell[][]): boolean {
    const tab = this.book.sheets[t]!;
    const rows = tab.rows!;
    if (rows.length + added.length > SHEET_ROWS_MAX) {
      this.show(inlineBar(`A tab holds at most ${SHEET_ROWS_MAX} rows, and this would make ${rows.length + added.length}.`, ["A ledger this long belongs in a project table, which a tab reads with source."], [this.dismissal()]));
      return false;
    }
    const long = added.length ? tooLong(this.book, t, added) : undefined;
    if (long) {
      this.show(inlineBar("These rows cannot be added here.", [long], [this.dismissal()]));
      return false;
    }
    this.change(() => {
      for (const c of cells) {
        const row = rows[c.row - 1]!;
        while (row.length < tab.columns.length) row.push(null);
        row[c.col] = c.cell;
      }
      rows.push(...fillNewRows(rows, added, rows.length + 1, tab.columns.length));
    });
    return true;
  }

  /**
   * Set cells and add rows in a tab over a table: an update for each row
   * changed and an insert for each added, sent as one batch the server makes
   * in one transaction, then the table read again. A refusal changes
   * nothing, and the bar says so.
   */
  private async writeTable(t: number, cells: PastePlan["cells"], added: SheetCell[][], keys: readonly unknown[]): Promise<boolean> {
    const tab = this.book.sheets[t]!;
    const src = tab.source!;
    const name = (c: number): string => tab.columns[c]!.column ?? tab.columns[c]!.label;
    const updates = new Map<number, Record<string, SheetCell>>();
    for (const c of cells) updates.set(c.row, { ...updates.get(c.row), [name(c.col)]: c.cell });
    const writes: TableWrite[] = [...updates].map(([row, values]) => ({ table: src.table, op: "update", values, key: { column: src.key, value: keys[row - 1] } }));
    for (const row of added) writes.push({ table: src.table, op: "insert", values: Object.fromEntries(row.flatMap((v, c) => (v === null ? [] : [[name(c), v]]))) });
    if (writes.length > TABLE_ROWS_IN) {
      this.show(inlineBar(`One paste or import writes at most ${TABLE_ROWS_IN} rows into a table, and this one has ${writes.length}.`, [], [this.dismissal()]));
      return false;
    }
    return this.writeAll(t, writes, "Saved");
  }

  /**
   * Writes to a table as one batch, then the table read again; the status
   * says what happened from what the server answered: all of them (and how
   * many found their row already gone), or none, with why.
   */
  private async writeAll(t: number, writes: TableWrite[], verb: "Saved" | "Deleted"): Promise<boolean> {
    const bridge = kos();
    const total = writes.length;
    this.render();
    this.say(`${verb === "Saved" ? "Saving" : "Deleting"} ${plural(total, "row")}\u2026`);
    let outcome: { done: number; gone: number; error?: string };
    try {
      if (!bridge?.writes) throw new Error("this KOS cannot write several rows at once; reload the dashboard");
      const got = await bridge.writes(writes);
      outcome = { done: got.done, gone: got.results.filter((r, i) => writes[i]!.op !== "insert" && r.changes === 0).length };
    } catch (e) {
      outcome = { done: 0, gone: 0, error: reason(e) };
    }
    await this.load(t);
    if (outcome.error !== undefined) {
      this.say(`Not ${verb.toLowerCase()}: nothing changed`, true);
      this.show(inlineBar(`Nothing was ${verb.toLowerCase()}, so the table is as it was.`, [outcome.error], [this.dismissal()], true));
      return false;
    }
    const gone = outcome.gone ? `; ${outcome.gone === 1 ? "1 was" : `${outcome.gone} were`} already gone` : "";
    this.say(`${verb} ${plural(outcome.done - outcome.gone, "row")}${gone}`);
    return true;
  }

  /** Ask for a CSV file with the frame's own file picker (a sandboxed frame keeps it), and preview it. */
  private pickFile(): void {
    this.root.querySelector(":scope > input[type=file]")?.remove();
    const input = el("input", { type: "file", accept: ".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain", hidden: true });
    input.addEventListener("cancel", () => input.remove());
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      if (file.size > IMPORT_BYTES_MAX) return this.say(`${file.name} is larger than an import reads (${IMPORT_BYTES_MAX / 1024 / 1024} MB)`, true);
      file.arrayBuffer().then(
        (bytes) => this.startImport(file.name, decodeText(bytes)),
        (e: unknown) => this.say(`${file.name} could not be read: ${reason(e)}`, true),
      );
    });
    this.root.append(input);
    input.click();
  }

  /** Start previewing a CSV's text: its delimiter, whether it leads with the tab's header, and its mapping, each as the file suggests. */
  private startImport(file: string, text: string): void {
    const delimiter = detectDelimiter(text);
    this.importing = { file, text, delimiter, header: false, map: [] };
    this.readAs(delimiter);
    this.drawImport();
  }

  /** Read the file being imported with a delimiter, and guess its header and mapping again. */
  private readAs(delimiter: Delimiter): void {
    const imp = this.importing!;
    const columns = this.book.sheets[this.tab]!.columns;
    const rows = parseDelimited(imp.text, delimiter);
    imp.delimiter = delimiter;
    imp.header = rows.length > 1 && isHeader(rows[0]!, columns);
    imp.map = autoMap(imp.header ? rows[0] : undefined, Math.max(0, ...rows.map((r) => r.length)), columns);
  }

  private drawImport(): void {
    const imp = this.importing;
    if (!imp) return;
    const t = this.tab;
    const tab = this.book.sheets[t]!;
    const columns = tab.columns;
    const rows = parseDelimited(imp.text, imp.delimiter);
    const width = Math.max(0, ...rows.map((r) => r.length));
    const fields = Array.from({ length: width }, (_, i) => (imp.header && rows[0]?.[i]?.trim() ? rows[0][i]!.trim() : `Column ${i + 1}`));
    const got = importRows(rows, imp.header, imp.map, columns);
    const room = tab.source ? TABLE_ROWS_IN : SHEET_ROWS_MAX - tab.rows!.length;
    const refusal =
      got.rows.length <= room
        ? tab.source
          ? undefined
          : tooLong(this.book, t, got.rows)
        : tab.source
          ? `An import writes at most ${TABLE_ROWS_IN} rows into a table, and this file has ${got.rows.length}.`
          : `A tab holds at most ${SHEET_ROWS_MAX} rows, and this file would make ${tab.rows!.length + got.rows.length}.`;
    const preview = got.rows.slice(0, PREVIEW_ROWS).map((r) => r.map((v, c) => formatValue(literalOf(v, columns[c]), columns[c])));
    const close = (): void => {
      this.importing = undefined;
      this.dismiss();
    };
    const keep = (document.activeElement as Element | null)?.getAttribute("aria-label");
    const panel = importPanel(
      { file: imp.file, delimiter: imp.delimiter, header: imp.header, fields, map: imp.map, columns, preview, count: got.rows.length, errors: got.errors, ...(refusal ? { refusal } : {}) },
      {
        delimiter: (d) => {
          this.readAs(d);
          this.drawImport();
        },
        header: (on) => {
          imp.header = on;
          imp.map = autoMap(on ? rows[0] : undefined, width, columns);
          this.drawImport();
        },
        map: (c, f) => {
          imp.map[c] = f;
          this.drawImport();
        },
        add: () => {
          this.importing = undefined;
          this.panel = undefined;
          const added = tab.source ? this.writeTable(t, [], got.rows, []) : Promise.resolve(this.keepRows(t, [], got.rows));
          void added.then((ok) => {
            if (ok && got.errors.length) this.show(inlineBar(`Added ${plural(got.rows.length, "row")} from ${imp.file}. ${plural(got.errors.length, "value")} did not fit and ${got.errors.length === 1 ? "was" : "were"} left empty.`, got.errors, [this.dismissal()]));
            else if (ok) this.show(undefined);
          });
        },
        cancel: close,
      },
    );
    this.show(panel, keep);
  }

  /** A column's menu: sort, rename, its type, and for a tab kept with the artifact, columns put in and taken out. */
  private columnMenu(col: number, anchor: HTMLElement): void {
    const wasOpen = this.menuOpen?.box.dataset.col === String(col);
    this.menuOpen?.close();
    if (wasOpen) return;
    const tab = this.book.sheets[this.tab]!;
    const column = tab.columns[col]!;
    const run = (fn: () => void) => (): void => {
      this.menuOpen?.close();
      fn();
    };
    const sortBy = (dir: 1 | -1) => run(() => {
      this.sort = { column: col, dir };
      this.renderGrid();
    });
    const items: MenuItem[] = [
      { label: "Sort A to Z", run: sortBy(1) },
      { label: "Sort Z to A", run: sortBy(-1) },
      "-",
      { label: "Rename", run: run(() => this.renameAt(col)) },
      { group: "Type" },
      ...TYPE_WORDS.map(([type, word]) => ({ label: word, checked: (column.type ?? "text") === type, run: run(() => this.retype(col, type, word)) })),
      "-",
      ...(tab.source
        ? [{ note: "This tab shows a table. Its columns change with the table, by asking KOS." }]
        : [
            { label: "Insert column left", run: run(() => this.addColumn(col)) },
            { label: "Insert column right", run: run(() => this.addColumn(col + 1)) },
            { label: "Delete column", tone: "danger" as const, run: run(() => this.dropColumn(col)) },
          ]),
    ];
    const box = menu(`${column.label} column`, items);
    box.dataset.col = String(col);
    this.root.append(box);
    const at = anchor.getBoundingClientRect();
    const home = this.root.getBoundingClientRect();
    box.style.left = `${Math.max(0, Math.min(at.right - home.left - box.offsetWidth, home.width - box.offsetWidth))}px`;
    box.style.top = `${at.bottom - home.top + 4}px`;
    box.style.maxHeight = `${Math.max(160, innerHeight - at.bottom - 12)}px`;
    const away = (e: Event): void => {
      if (!box.contains(e.target as Node) && e.target !== anchor) this.menuOpen?.close();
    };
    const key = (e: KeyboardEvent): void => {
      // Escape, or Tab out of it, closes the menu and gives its button the focus back.
      if (e.key !== "Escape" && e.key !== "Tab") return;
      e.preventDefault();
      this.menuOpen?.close();
      anchor.focus();
    };
    const scroll = this.root.querySelector(".sheet-scroll");
    anchor.setAttribute("aria-expanded", "true");
    const close = (): void => {
      anchor.setAttribute("aria-expanded", "false");
      box.remove();
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", key, true);
      scroll?.removeEventListener("scroll", close);
      this.menuOpen = undefined;
    };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", key, true);
    scroll?.addEventListener("scroll", close, { passive: true });
    this.menuOpen = { box, close };
    box.querySelector<HTMLButtonElement>("button")?.focus();
  }

  /** Rename a column where its name is drawn: Enter or leaving keeps a new name, Escape the old one, and two columns never share one. */
  private renameAt(col: number): void {
    const th = this.root.querySelectorAll<HTMLElement>(".sheet-grid thead th:not(.rownum)")[col];
    if (!th) return;
    const t = this.tab;
    const columns = this.book.sheets[t]!.columns;
    const was = columns[col]!.label;
    const input = el("input", { type: "text", class: "sheet-rename", "aria-label": `Rename ${was}` });
    input.value = was;
    th.classList.add("renaming");
    th.append(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save: boolean, leaving: boolean): void => {
      if (done) return;
      const label = input.value.trim();
      const taken = columns.some((c, i) => i !== col && c.label.trim().toLowerCase() === label.toLowerCase());
      if (save && label && label !== was && taken && !leaving) return this.say(`Another column is called ${label}`, true);
      done = true;
      if (save && label && label !== was && !taken) this.change(() => renameColumn(this.book, t, col, label));
      else this.renderGrid();
      this.moveTo(this.focus.row, this.focus.col);
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true, false);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false, false);
      }
    });
    input.addEventListener("blur", () => finish(true, true));
  }

  private retype(col: number, type: SheetColumnType, word: string): void {
    const t = this.tab;
    const label = this.book.sheets[t]!.columns[col]!.label;
    let unread = 0;
    this.change(() => {
      unread = retypeColumn(this.book, t, col, type).unread;
    });
    if (unread) this.show(inlineBar(`${plural(unread, "value")} in ${label} ${unread === 1 ? "does" : "do"} not read as ${word.toLowerCase()} and ${unread === 1 ? "was" : "were"} kept as typed.`, [], [this.dismissal()]));
  }

  /** Put a new column in before `at`, and name it where it is drawn. */
  private addColumn(at: number): void {
    const t = this.tab;
    this.sort = undefined;
    this.filter.column = -1;
    this.change(() => insertColumn(this.book, t, at, { label: freshLabel(this.book.sheets[t]!.columns, "Column") }));
    this.renameAt(at);
  }

  /** Take a column out: at once when it is empty, after asking when it holds values. */
  private dropColumn(col: number): void {
    const t = this.tab;
    const tab = this.book.sheets[t]!;
    if (tab.columns.length === 1) return this.say("A tab keeps at least one column", true);
    const filled = (tab.rows ?? []).filter((r) => r[col] !== null && r[col] !== undefined && r[col] !== "").length;
    const go = (): void => {
      this.panel = undefined;
      this.sort = undefined;
      this.filter.column = -1;
      this.change(() => deleteColumn(this.book, t, col));
    };
    if (!filled) return go();
    const label = tab.columns[col]!.label;
    this.show(inlineBar(`Delete the column ${label} and its ${plural(filled, "value")}? Undo brings it back.`, [], [{ label: "Delete column", tone: "danger", run: go }, { label: "Cancel", run: () => this.dismiss() }], true));
  }

  /** Pick rows by their numbers: a press picks one (or none, pressed again), Shift a run of them as shown, Cmd or Ctrl (or Shift+Space in a cell) one more or one fewer. */
  private pick(r: number, shown: readonly number[], how: { run: boolean; add: boolean }): void {
    if (how.run && this.pickedFrom !== undefined && shown.includes(this.pickedFrom)) {
      const [a, b] = [shown.indexOf(this.pickedFrom), shown.indexOf(r)].sort((x, y) => x - y);
      this.picked = new Set(shown.slice(a!, b! + 1));
    } else if (how.add) {
      if (!this.picked.delete(r)) this.picked.add(r);
      this.pickedFrom = r;
    } else {
      this.picked = this.picked.size === 1 && this.picked.has(r) ? new Set() : new Set([r]);
      this.pickedFrom = r;
    }
    const keys = this.loaded.get(this.tab)?.keys ?? [];
    this.pickedKeys = new Map([...this.picked].map((p) => [p, keys[p - 1]]));
    this.refreshPicks();
  }

  /** Mark the picked rows and show what can be done with them, without drawing the grid again. */
  private refreshPicks(): void {
    for (const tr of this.root.querySelectorAll<HTMLTableRowElement>("tbody tr[data-row]")) {
      const on = this.picked.has(Number(tr.dataset.row));
      tr.classList.toggle("picked", on);
      tr.querySelector(".pick")?.setAttribute("aria-pressed", String(on));
    }
    this.root.querySelector(":scope > .sheet-rowbar")?.remove();
    if (this.picked.size && this.editable(this.tab)) this.root.querySelector(":scope > .sheet-tools")?.after(this.rowBar());
    this.fit();
  }

  private rowBar(): HTMLElement {
    const tab = this.book.sheets[this.tab]!;
    const n = this.picked.size;
    const actions: Action[] = tab.source
      ? []
      : [
          { label: "Insert above", run: () => this.insertAt("above") },
          { label: "Insert below", run: () => this.insertAt("below") },
        ];
    actions.push(
      { label: n === 1 ? "Delete row" : `Delete ${n} rows`, tone: "danger", run: () => this.deletePicked() },
      {
        label: "Clear",
        run: () => {
          this.picked.clear();
          this.refreshPicks();
        },
      },
    );
    const box = el("div", { class: "sheet-rowbar", role: "toolbar", "aria-label": "Picked rows" }, el("span", {}, `${plural(n, "row")} picked`));
    for (const a of actions) {
      const b = el("button", { type: "button", class: a.tone }, a.label);
      b.addEventListener("click", a.run);
      box.append(b);
    }
    return box;
  }

  /** As many empty rows as are picked, above the first picked or below the last. */
  private insertAt(where: "above" | "below"): void {
    const t = this.tab;
    const tab = this.book.sheets[t]!;
    const rows = [...this.picked].sort((a, b) => a - b);
    if (tab.rows!.length + rows.length > SHEET_ROWS_MAX) return this.say(`A tab holds at most ${SHEET_ROWS_MAX} rows`, true);
    const at = where === "above" ? rows[0]! : rows[rows.length - 1]! + 1;
    this.sort = undefined;
    this.filter.text = "";
    this.change(() => insertRows(this.book, t, at, rows.map(() => tab.columns.map(() => null))));
    this.picked = new Set(rows.map((_, i) => at + i));
    this.refreshPicks();
    this.moveTo(at, this.focus.col);
  }

  /** Delete the picked rows: one at once (Undo brings it back), more after asking, and a table's always after asking, since Undo cannot. */
  private deletePicked(): void {
    const t = this.tab;
    const tab = this.book.sheets[t]!;
    const rows = [...this.picked].sort((a, b) => a - b);
    const cancel: Action = { label: "Cancel", run: () => this.dismiss() };
    if (tab.source) {
      const them = rows.length === 1 ? "it" : "them";
      return this.show(inlineBar(`Delete ${plural(rows.length, "row")} from the table ${tab.source.table}? Undo cannot bring ${them} back.`, [], [{ label: rows.length === 1 ? "Delete row" : `Delete ${rows.length} rows`, tone: "danger", run: () => void this.deleteTableRows(t, rows.map((r) => this.pickedKeys.get(r))) }, cancel], true));
    }
    const go = (): void => {
      this.panel = undefined;
      this.picked.clear();
      this.change(() => deleteRows(this.book, t, rows));
    };
    if (rows.length === 1) return go();
    this.show(inlineBar(`Delete ${rows.length} rows? Undo brings them back.`, [], [{ label: `Delete ${rows.length} rows`, tone: "danger", run: go }, cancel], true));
  }

  /** Delete a table's rows by the keys they had when picked, never by where they stand now. */
  private async deleteTableRows(t: number, keys: readonly unknown[]): Promise<void> {
    const src = this.book.sheets[t]!.source!;
    this.panel = undefined;
    this.picked.clear();
    this.pickedKeys.clear();
    await this.writeAll(t, keys.map((value) => ({ table: src.table, op: "delete", key: { column: src.key, value } })), "Deleted");
  }

  private drawCharts(): void {
    const box = this.root.querySelector(".sheet-charts");
    if (!box) return;
    box.replaceChildren();
    for (const chart of this.book.charts ?? []) {
      const t = this.wb.tabIndex(chart.sheet);
      const labels = this.wb.range(chart.sheet, chart.labels);
      const values = this.wb.range(chart.sheet, chart.values);
      const area = el("div", { role: "img", "aria-label": chart.title });
      const fig = el("figure", {}, el("figcaption", {}, chart.title), area);
      box.append(fig);
      if (isError(labels) || isError(values) || t < 0) {
        area.append(el("p", { class: "sheet-error" }, `This chart's ranges do not read: ${isError(labels) ? labels.why : isError(values) ? values.why : "no such tab"}`));
        continue;
      }
      const labelCol = this.wb.columns(t)[Number.isNaN(colOf(chart.labels)) ? 0 : colOf(chart.labels)];
      const data = {
        labels: labels.map((v) => formatValue(v, labelCol)),
        values: values.map((v) => (typeof v === "number" ? v : 0)),
      };
      const draw = chart.type === "line" ? line : chart.type === "pie" ? pie : bar;
      draw(area, data);
    }
  }
}

/** The first column a range names: "C2:C9" -> 2. */
function colOf(range: string): number {
  const m = /([A-Za-z]{1,3})\$?\d/.exec(range.replace(/^.*!/, "").replace(/\$/g, ""));
  if (!m) return NaN;
  let n = 0;
  for (const ch of m[1]!.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const cls = (...names: (string | false | undefined)[]): string | undefined => names.filter(Boolean).join(" ") || undefined;

/** Keep the first columns in view: each frozen cell sits at the width of what is left of it, and a phone's first column at the row numbers'. */
function pinColumns(table: HTMLTableElement): void {
  const head = table.tHead?.rows[0];
  if (!head) return;
  // A phone's first column a fraction over the numbers rather than short of them, so nothing sliding under shows through a seam.
  table.style.setProperty("--sheet-lead", `${Math.floor(head.cells[0]?.getBoundingClientRect().width ?? 0)}px`);
  const freeze = head.querySelectorAll(".frozen").length;
  let left = head.cells[0]?.offsetWidth ?? 0;
  const lefts: number[] = [];
  for (let i = 1; i <= freeze; i++) {
    lefts.push(left);
    left += head.cells[i]?.offsetWidth ?? 0;
  }
  for (const row of table.rows) {
    for (let i = 1; i <= freeze; i++) {
      const cell = row.cells[i];
      if (cell && cell.colSpan === 1) cell.style.left = `${lefts[i - 1]}px`;
    }
  }
}

/** The workbook in a data script, or why it cannot be read. */
export function readBook(text: string): SheetBook | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return `The sheet's data is not valid JSON: ${reason(e)}`;
  }
  const book = raw as Partial<SheetBook> | null;
  if (!book || !Array.isArray(book.sheets) || !book.sheets.length) return "The sheet's data needs sheets: a list of at least one tab.";
  for (const t of book.sheets) {
    if (!t || typeof t.name !== "string" || (!Array.isArray(t.columns) && !t.pivot)) return "Every tab needs a name and its columns.";
    t.columns ??= [];
    if (!t.rows && !t.source && !t.pivot) t.rows = [];
  }
  return book as SheetBook;
}

export function startSheets(): void {
  hideRepeatedTitle();
  for (const script of document.querySelectorAll<HTMLScriptElement>('script[type="application/json"][data-sheet]')) {
    const book = readBook(script.textContent ?? "");
    if (typeof book === "string") script.after(el("p", { class: "sheet-error", role: "alert" }, book));
    else new Sheet(book, script);
  }
}

// Inlined in a frame it runs as a script; imported by a test it waits to be called.
if (typeof document !== "undefined" && document.currentScript) {
  addStyle(SHEET_CSS, "kos-sheet-css");
  ready(startSheets);
}
