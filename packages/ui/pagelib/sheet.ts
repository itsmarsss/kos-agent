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
 */

import type { SheetBook, SheetCell, SheetColumn, SheetTab } from "@kos/shared";
import { Workbook, columnLetter, findColumn, formatValue, isError, isNumeric, literalOf, sortValue, sourceQuery, totalsRow, type Value } from "@kos/shared/sheetformula";

import { bar, line, pie } from "./chartdraw.js";
import { SHEET_CSS } from "./sheet.css.js";
import { addStyle, editable, el, kos, ready, reason } from "./runtime.js";

/** How long after an edit the workbook is saved, so a run of edits is one version. */
export const SAVE_DELAY_MS = 600;
/** The least time between two saves: KOS takes one of the owner's edits to an artifact every 2 s (PageStore's EDIT_GAP_MS). */
export const SAVE_GAP_MS = 2100;

/** The shortest a grid is drawn, however little room the frame has. */
const SHEET_MIN_HEIGHT = 320;
/** How far in from its right edge a phone fades a grid with more to see (sheet.css.ts). */
const SHEET_FADE = 40;
/** Where the stylesheet's phone layout starts (sheet.css.ts). */
const PHONE_QUERY = "(max-width: 560px)";

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

/** Past this many characters a cell runs over two lines of a phone's column. */
const TWO_LINES = 28;

/**
 * Whether a column holds words a phone wraps, up to two lines, so the grid
 * narrows rather than runs off. Free text, most of whose cells two lines
 * would not hold (notes, descriptions), stays on one line and is cut: wrapped,
 * it would make every row tall, out of view as much as in it.
 */
export function wraps(column: SheetColumn, cells: readonly Value[]): boolean {
  if ((column.type ?? "text") !== "text") return false;
  const lengths = cells.filter((v) => v !== null && v !== "").map((v) => formatValue(v, column).length).sort((a, b) => a - b);
  return !lengths.length || lengths[Math.floor(lengths.length / 2)]! <= TWO_LINES;
}

/** What an owner typed, as a cell to store: a formula stays text, a number in a numeric column becomes one. */
export function cellFromInput(text: string, column: SheetColumn | undefined): SheetCell {
  const t = text.trim();
  if (t === "") return null;
  if (t.startsWith("=")) return t;
  const v = literalOf(t, column);
  return isError(v) ? t : v;
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
        const w = Math.round(e?.contentRect.width ?? 0);
        if (w !== 0 && w !== this.chartsAt) {
          this.chartsAt = w;
          this.drawCharts();
        }
        this.markMore();
      });
      this.resizeWatch.observe(this.root);
    }
    // The phone's tighter cells move where each frozen column starts.
    globalThis.matchMedia?.(PHONE_QUERY)?.addEventListener("change", () => this.pin());
    addEventListener("resize", () => this.fit());
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
    this.root.style.setProperty("--sheet-height", `${Math.max(SHEET_MIN_HEIGHT, room)}px`);
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
          rows: res.rows.map((r) => tab.columns.map((c) => {
            const v = r[c.column ?? c.label];
            return v === undefined ? null : (v as SheetCell);
          })),
        });
      } catch (e) {
        this.loaded.set(i, { keys: [], rows: [], error: reason(e) });
      }
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
    const tools = el("div", { class: "sheet-tools" }, search, which, el("span", { class: "sheet-rows" }), el("span", { class: "sheet-more", "aria-hidden": "true" }), el("span", { class: "sheet-spacer" }), this.status);
    if (tab.rows && !tab.pivot && this.editable(t)) {
      const add = el("button", { type: "button" }, "Add row");
      add.addEventListener("click", () => this.addRow());
      tools.append(add);
    }
    parts.push(tools);
    const err = this.loaded.get(t)?.error;
    if (err) parts.push(el("p", { class: "sheet-error", role: "alert" }, `The rows could not be read: ${err}`));
    const scroll = el("div", { class: "sheet-scroll" });
    scroll.addEventListener("scroll", () => this.markMore(), { passive: true });
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
    const key = keyColumn(columns, tab.totals, freeze);
    const wrapped = columns.map((c, i) => wraps(c, values.map((row) => row[i] ?? null)));
    const kinds = (c: SheetColumn, i: number): (string | false)[] => [isNumeric(c) && "num", wrapped[i]! && "wrap", i === key && "key", i < freeze && "frozen", i === freeze - 1 && "frozen-edge"];
    const count = this.root.querySelector(".sheet-rows");
    if (count) count.textContent = rows.length === values.length ? `${values.length} rows` : `${rows.length} of ${values.length} rows`;

    const headRow = el("tr", {}, el("th", { class: "rownum", scope: "col", "aria-label": "Row" }, ""));
    columns.forEach((c, i) => {
      const dir = this.sort?.column === i ? (this.sort.dir === 1 ? "ascending" : "descending") : "none";
      const b = el("button", { type: "button", title: `Sort by ${c.label}` }, el("span", { class: "letter" }, columnLetter(i)), el("span", { class: "name" }, c.label));
      b.addEventListener("click", () => {
        this.sort = this.sort?.column !== i ? { column: i, dir: 1 } : this.sort.dir === 1 ? { column: i, dir: -1 } : undefined;
        this.renderGrid();
      });
      const th = el("th", { scope: "col", "aria-sort": dir, class: cls(...kinds(c, i)) }, b);
      // A width the stylesheet keeps on a desktop and lets go of on a phone.
      if (c.width) th.style.setProperty("--sheet-col", `${c.width}ch`);
      headRow.append(th);
    });

    const body = el("tbody");
    for (const r of rows) {
      const tr = el("tr", {}, el("th", { class: "rownum", scope: "row" }, String(r)));
      columns.forEach((c, i) => tr.append(this.cell(t, r, i, values[r - 1]![i] ?? null, c, kinds(c, i))));
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
      if (freeze) this.pin();
      this.markMore();
    });
  }

  /**
   * Mark a grid with more to its right, and say how many columns are out of
   * view. A phone cut the last column at the box's edge, and it read as the
   * end of the row rather than a grid that scrolls. The key column is held
   * when it reaches into the edge's fade with more past it: the fade then
   * narrows to what shows past it, so the figure is never faded, and its
   * shadow says what slides under it.
   */
  private markMore(): void {
    const scroll = this.root.querySelector<HTMLElement>(".sheet-scroll");
    if (!scroll) return;
    const more = Math.ceil(scroll.scrollLeft + scroll.clientWidth) < scroll.scrollWidth - 1;
    const head = [...scroll.querySelectorAll<HTMLElement>(".sheet-grid thead th:not(.rownum)")];
    const keyCell = head.find((th) => th.classList.contains("key"));
    const key = keyCell?.getBoundingClientRect();
    const right = scroll.getBoundingClientRect().left + scroll.clientLeft + scroll.clientWidth;
    const held = more && !!key && key.right > right - SHEET_FADE;
    const edge = held ? key.left : right;
    const out = head.filter((th) => th !== keyCell && th.getBoundingClientRect().right > edge + 1).length;
    scroll.classList.toggle("more", more);
    scroll.classList.toggle("held", held);
    scroll.style.setProperty("--sheet-fade", `${held ? Math.max(0, Math.floor(right - key.right)) : SHEET_FADE}px`);
    const cue = this.root.querySelector(".sheet-more");
    if (cue) cue.textContent = out ? `${out} more column${out === 1 ? "" : "s"} \u2192` : "";
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
      typeof v === "boolean" ? (v ? "✓" : "") : kinds.includes("wrap") ? el("span", { class: "lines" }, formatValue(v, column)) : formatValue(v, column),
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
        await kos()!.write(tab.source.table, "update", { [name]: cell }, { column: tab.source.key, value: loaded.keys[row - 1] });
        loaded.rows[row - 1]![col] = cell;
        this.say("Saved");
        await this.load(t);
      } catch (e) {
        this.say(`Not saved: ${reason(e)}`, true);
      }
      return after();
    }
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
    tab.rows!.push(tab.columns.map(() => null));
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

/** Keep the first columns in view: each frozen cell sits at the width of what is left of it. */
function pinColumns(table: HTMLTableElement): void {
  const head = table.tHead?.rows[0];
  if (!head) return;
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
