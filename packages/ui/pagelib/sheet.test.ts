// @vitest-environment jsdom
import type { SheetBook } from "@kos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SAVE_DELAY_MS, SAVE_GAP_MS, cellFromInput, keyColumn, readBook, sourceQuery, startSheets, viewRows } from "./sheet.js";

const BOOK: SheetBook = {
  sheets: [
    {
      name: "Expenses",
      columns: [{ label: "Date", type: "date" }, { label: "Category" }, { label: "Amount", type: "currency", currency: "USD" }],
      rows: [
        ["2026-09-02", "Groceries", 84.1],
        ["2026-09-03", "Fuel", 52],
        ["2026-09-09", "Groceries", 61.4],
        ["2026-09-10", "Rent", 1400],
      ],
      totals: { Amount: "sum" },
      freeze: 1,
    },
    { name: "By category", columns: [], pivot: { from: "Expenses", by: "Category", values: [{ column: "Amount", fn: "sum" }] } },
    { name: "Check", columns: [{ label: "Groceries", type: "currency" }], rows: [['=SUMIF(Expenses!B1:B9,"groceries",Expenses!C1:C9)']] },
  ],
  charts: [{ type: "bar", title: "Spend by category", sheet: "By category", labels: "A1:A9", values: "B1:B9" }],
};

function mount(book: SheetBook = structuredClone(BOOK)): HTMLElement {
  document.body.innerHTML = `<h1>September</h1><script type="application/json" data-sheet>${JSON.stringify(book)}</script>`;
  startSheets();
  return document.querySelector(".sheet")!;
}
const cells = (root: Element): string[][] => [...root.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent ?? ""));
const tab = (root: Element, name: string): void => [...root.querySelectorAll<HTMLButtonElement>(".sheet-tabs button")].find((b) => b.textContent === name)!.click();

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
  delete (window as { kos?: unknown }).kos;
});

describe("pure helpers", () => {
  it("reads typed input as a cell", () => {
    expect(cellFromInput(" 1,200.5 ", { label: "x", type: "currency" })).toBe(1200.5);
    expect(cellFromInput("=A1*2", { label: "x", type: "number" })).toBe("=A1*2");
    expect(cellFromInput("", { label: "x" })).toBe(null);
    expect(cellFromInput("12", { label: "x" })).toBe("12");
  });

  it("filters in one column or any, and sorts without losing row numbers", () => {
    const cols = [{ label: "a" }, { label: "n", type: "number" as const }];
    const values = [["pear", 3], ["apple", 10], ["plum", 1]];
    expect(viewRows(values, cols, { text: "p", column: 0 }, undefined)).toEqual([1, 2, 3]);
    expect(viewRows(values, cols, { text: "plu", column: -1 }, undefined)).toEqual([3]);
    expect(viewRows(values, cols, { text: "", column: -1 }, { column: 1, dir: 1 })).toEqual([3, 1, 2]);
    expect(viewRows(values, cols, { text: "", column: -1 }, { column: 0, dir: -1 })).toEqual([3, 1, 2]);
  });

  it("reads a source table with quoted names and a safe order", () => {
    const tab = { name: "T", columns: [{ label: "When", column: "date" }, { label: "amount" }], source: { table: "budget_tx", key: "id", orderBy: "date desc" } };
    expect(sourceQuery(tab)).toBe('SELECT "id" AS __key, "date", "amount" FROM "budget_tx" ORDER BY "date" DESC');
    expect(sourceQuery({ ...tab, source: { ...tab.source, orderBy: "date; drop" } })).toBe('SELECT "id" AS __key, "date", "amount" FROM "budget_tx"');
    expect(sourceQuery({ ...tab, source: { table: "x y", key: "id" } })).toBeUndefined();
  });

  it("keys a phone's grid on the figure it totals, else its first currency, never a frozen column", () => {
    const columns = [{ label: "Date", type: "date" as const }, { label: "Item" }, { label: "Tax", type: "currency" as const }, { label: "Amount", type: "currency" as const }, { label: "Paid by" }];
    expect(keyColumn(columns, { Amount: "sum" }, 1)).toBe(3);
    expect(keyColumn(columns, { d: "sum", B: "count" }, 1)).toBe(3);
    expect(keyColumn(columns, undefined, 1)).toBe(2);
    expect(keyColumn(columns, { Amount: "sum" }, 4)).toBe(-1);
    expect(keyColumn(columns.slice(0, 2), { Item: "count" }, 0)).toBe(-1);
  });

  it("explains a workbook it cannot read", () => {
    expect(readBook("{oops")).toMatch(/not valid JSON/);
    expect(readBook('{"sheets":[]}')).toMatch(/at least one tab/);
    expect(typeof readBook(JSON.stringify(BOOK))).toBe("object");
  });
});

describe("kos-sheet in a page", () => {
  it("draws typed, formatted cells with a totals row and row numbers", () => {
    const root = mount();
    expect(root.previousElementSibling?.tagName).toBe("SCRIPT");
    expect(cells(root)[0]).toEqual(["Sep 2, 2026", "Groceries", "$84.10"]);
    expect(root.querySelector("tfoot")!.textContent).toContain("$1,597.50");
    expect([...root.querySelectorAll("tbody .rownum")].map((n) => n.textContent)).toEqual(["1", "2", "3", "4"]);
    expect(root.querySelector("thead th.num")).not.toBeNull();
    expect(root.querySelector("thead th.frozen")).not.toBeNull();
    // Words wrap on a phone and the amount holds at its right edge: every cell of each column says so.
    expect([...root.querySelectorAll("tbody tr:first-child td")].map((td) => ["wrap", "key"].filter((c) => td.classList.contains(c)).join())).toEqual(["", "wrap", "key"]);
    expect(root.querySelector("tfoot td.key")?.textContent).toBe("$1,597.50");
  });

  it("sorts by a header and filters, totalling what is shown", () => {
    const root = mount();
    const amount = [...root.querySelectorAll<HTMLButtonElement>("thead button")][2]!;
    amount.click();
    expect(cells(root).map((r) => r[2])).toEqual(["$52.00", "$61.40", "$84.10", "$1,400.00"]);
    root.querySelector<HTMLButtonElement>("thead th:nth-child(4) button")!.click();
    expect(cells(root)[0]![2]).toBe("$1,400.00");
    const search = root.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = "groc";
    search.dispatchEvent(new Event("input"));
    expect(cells(root)).toHaveLength(2);
    expect(root.querySelector(".sheet-rows")!.textContent).toBe("2 of 4 rows");
    expect(root.querySelector("tfoot")!.textContent).toContain("$145.50");
  });

  it("shows pivots and cross-tab formulas, and charts from a range", () => {
    const root = mount();
    tab(root, "By category");
    expect(cells(root)).toEqual([
      ["Rent", "$1,400.00"],
      ["Groceries", "$145.50"],
      ["Fuel", "$52.00"],
    ]);
    tab(root, "Check");
    expect(cells(root)[0]).toEqual(["$145.50"]);
    expect(root.querySelector("td.formula")!.getAttribute("title")).toContain("SUMIF");
    expect(root.querySelector(".sheet-charts figcaption")!.textContent).toBe("Spend by category");
    expect(root.querySelectorAll(".sheet-charts rect").length).toBe(3);
  });

  it("is read only without kos.save", () => {
    const root = mount();
    expect(root.querySelector(".sheet-tools button")).toBeNull();
    const td = root.querySelector<HTMLTableCellElement>("td")!;
    td.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(td.querySelector("input")).toBeNull();
  });

  it("edits a stored cell, recomputes, and saves the workbook once after a run of edits", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue({ version: 3 });
    (window as { kos?: unknown }).kos = { save };
    const root = mount();
    const edit = (row: number, col: number, text: string): void => {
      const td = root.querySelector<HTMLTableCellElement>(`td[data-row="${row}"][data-col="${col}"]`)!;
      td.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      const input = td.querySelector("input")!;
      input.value = text;
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    };
    edit(2, 2, "60");
    edit(4, 2, "=C2*10");
    expect(cells(root)[3]![2]).toBe("$600.00");
    expect(root.querySelector("tfoot")!.textContent).toContain("$805.50");
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 10);
    expect(save).toHaveBeenCalledTimes(1);
    const sent = save.mock.calls[0]![0] as { sheet: SheetBook };
    expect(sent.sheet.sheets[0]!.rows![1]![2]).toBe(60);
    expect(sent.sheet.sheets[0]!.rows![3]![2]).toBe("=C2*10");
    expect(root.querySelector(".sheet-status")!.textContent).toBe("Saved");
  });

  it("spaces its saves as far apart as KOS takes them", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue({});
    (window as { kos?: unknown }).kos = { save };
    const root = mount();
    const edit = (text: string): void => {
      const td = root.querySelector<HTMLTableCellElement>('td[data-row="1"][data-col="2"]')!;
      td.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      const input = td.querySelector("input")!;
      input.value = text;
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    };
    edit("1");
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);
    edit("2");
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 10);
    expect(save).toHaveBeenCalledTimes(1);
    // The second is due a full gap after the first went.
    await vi.advanceTimersByTimeAsync(SAVE_GAP_MS - SAVE_DELAY_MS - 20);
    expect(save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("adds a row and moves with the arrow keys", () => {
    (window as { kos?: unknown }).kos = { save: vi.fn().mockResolvedValue({}) };
    const root = mount();
    root.querySelector<HTMLButtonElement>(".sheet-tools button")!.click();
    expect(cells(root)).toHaveLength(5);
    const focused = root.querySelector<HTMLTableCellElement>("td.focus")!;
    expect(focused.dataset.row).toBe("5");
    focused.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(root.querySelector<HTMLTableCellElement>("td.focus")!.dataset.row).toBe("4");
    root.querySelector("td.focus")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(root.querySelector<HTMLTableCellElement>("td.focus")!.dataset.col).toBe("1");
  });

  it("reads a table through kos.query and writes an edit through kos.write", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ __key: 7, item: "Paint", cost: 30 }, { __key: 9, item: "Brushes", cost: 12 }] });
    const write = vi.fn().mockResolvedValue({ changes: 1 });
    (window as { kos?: unknown }).kos = { query, write };
    const root = mount({ sheets: [{ name: "Supplies", columns: [{ label: "Item", column: "item" }, { label: "Cost", column: "cost", type: "currency" }], source: { table: "studio_supplies", key: "id" }, totals: { Cost: "sum" } }] });
    await vi.waitFor(() => expect(cells(root)).toHaveLength(2));
    expect(query.mock.calls[0]![0]).toBe('SELECT "id" AS __key, "item", "cost" FROM "studio_supplies"');
    expect(root.querySelector("tfoot")!.textContent).toContain("$42.00");
    const td = root.querySelector<HTMLTableCellElement>('td[data-row="2"][data-col="1"]')!;
    td.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const input = td.querySelector("input")!;
    input.value = "15";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith("studio_supplies", "update", { cost: 15 }, { column: "id", value: 9 }));
  });

  it("shows the bridge's words when a write is refused", async () => {
    (window as { kos?: unknown }).kos = {
      query: vi.fn().mockResolvedValue({ rows: [{ __key: 1, item: "Paint" }] }),
      write: vi.fn().mockRejectedValue(new Error("this page does not declare that table")),
    };
    const root = mount({ sheets: [{ name: "S", columns: [{ label: "Item", column: "item" }], source: { table: "t", key: "id" } }] });
    await vi.waitFor(() => expect(cells(root)).toHaveLength(1));
    const td = root.querySelector<HTMLTableCellElement>("td")!;
    td.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true }));
    td.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(root.querySelector(".sheet-status")!.textContent).toBe("Not saved: this page does not declare that table"));
    expect(cells(root)[0]![0]).toBe("Paint");
  });

  it("says what is wrong with data it cannot read", () => {
    document.body.innerHTML = `<script type="application/json" data-sheet>{"sheets": 3}</script>`;
    startSheets();
    expect(document.querySelector(".sheet-error")!.textContent).toMatch(/at least one tab/);
  });

  it("says why a tab cannot be drawn, keeping its tabs, instead of leaving the sheet blank", () => {
    const book = structuredClone(BOOK);
    book.sheets.unshift({ name: "Broken", columns: [], pivot: { from: "Expenses", by: "Category", values: "Amount" as never } });
    book.charts = [];
    const root = mount(book);
    expect(root.querySelector(".sheet-error")!.textContent).toMatch(/^This tab could not be drawn: /);
    tab(root, "Expenses");
    expect(cells(root)).toHaveLength(4);
  });
});
