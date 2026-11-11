// @vitest-environment jsdom
import type { SheetBook } from "@kos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SAVE_DELAY_MS, SAVE_GAP_MS, cellFromInput, keyColumn, readBook, startSheets, viewRows, wraps } from "./sheet.js";

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

/** A paste of these rows (tab-separated, as a spreadsheet copies them) at the focused cell, or HTML alone. */
function paste(root: Element, text: string, html = ""): void {
  const target = root.querySelector("td.focus") ?? root.querySelector("td")!;
  const e = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "clipboardData", { value: { getData: (type: string) => (type === "text/plain" ? text : type === "text/html" ? html : "") } });
  target.dispatchEvent(e);
}
const click = (root: Element, label: string): void => {
  const b = [...root.querySelectorAll<HTMLButtonElement>("button")].find((n) => n.textContent === label || n.getAttribute("aria-label") === label);
  if (!b) throw new Error(`no button ${label}: ${[...root.querySelectorAll("button")].map((n) => n.textContent).join(", ")}`);
  b.click();
};
const focusCell = (root: Element, row: number, col: number): void => root.querySelector<HTMLElement>(`td[data-row="${row}"][data-col="${col}"]`)!.click();
const heads = (root: Element): string[] => [...root.querySelectorAll("thead th:not(.rownum) .name")].map((n) => n.textContent ?? "");
const saved = async (save: ReturnType<typeof vi.fn>): Promise<SheetBook> => {
  await vi.advanceTimersByTimeAsync(SAVE_GAP_MS + 10);
  return (save.mock.calls.at(-1)![0] as { sheet: SheetBook }).sheet;
};

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
    expect(cellFromInput("Nov 3, 2026", { label: "x", type: "date" })).toBe("2026-11-03");
    expect(cellFromInput("soon", { label: "x", type: "date" })).toBe("soon");
  });

  it("filters in one column or any, and sorts without losing row numbers", () => {
    const cols = [{ label: "a" }, { label: "n", type: "number" as const }];
    const values = [["pear", 3], ["apple", 10], ["plum", 1]];
    expect(viewRows(values, cols, { text: "p", column: 0 }, undefined)).toEqual([1, 2, 3]);
    expect(viewRows(values, cols, { text: "plu", column: -1 }, undefined)).toEqual([3]);
    expect(viewRows(values, cols, { text: "", column: -1 }, { column: 1, dir: 1 })).toEqual([3, 1, 2]);
    expect(viewRows(values, cols, { text: "", column: -1 }, { column: 0, dir: -1 })).toEqual([3, 1, 2]);
  });

  it("keys a phone's grid on the figure it totals, else its first currency, never a frozen column", () => {
    const columns = [{ label: "Date", type: "date" as const }, { label: "Item" }, { label: "Tax", type: "currency" as const }, { label: "Amount", type: "currency" as const }, { label: "Paid by" }];
    expect(keyColumn(columns, { Amount: "sum" }, 1)).toBe(3);
    expect(keyColumn(columns, { d: "sum", B: "count" }, 1)).toBe(3);
    expect(keyColumn(columns, undefined, 1)).toBe(2);
    expect(keyColumn(columns, { Amount: "sum" }, 4)).toBe(-1);
    expect(keyColumn(columns.slice(0, 2), { Item: "count" }, 0)).toBe(-1);
  });

  it("wraps a phone's short words, never its figures or its free text", () => {
    const notes = ["Paid early to keep the discount on the lease", "Split with Sam, he sends his half Friday", "Ok"];
    expect(wraps({ label: "Category" }, ["Housing", "Groceries", null])).toBe(true);
    expect(wraps({ label: "Notes" }, notes)).toBe(false);
    // One long note among short words is cut by the clamp, not taken for free text.
    expect(wraps({ label: "Item" }, ["Rent", notes[0]!, "Pizza night"])).toBe(true);
    expect(wraps({ label: "Amount", type: "currency" }, [1650])).toBe(false);
    expect(wraps({ label: "Empty" }, [])).toBe(true);
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

describe("pasting, importing, and changing the shape", () => {
  const owned = (): { root: HTMLElement; save: ReturnType<typeof vi.fn> } => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue({});
    (window as { kos?: unknown }).kos = { save };
    return { root: mount(), save };
  };

  it("adds pasted rows past the last and fills empty cells at once, by the columns' types", async () => {
    const { root, save } = owned();
    // The first pasted row is the fourth as it is, so nothing filled changes and nothing asks.
    focusCell(root, 4, 0);
    paste(root, "2026-09-10\tRent\t1400\nSep 12, 2026\tBooks\t$1,020.50\n");
    expect(root.querySelector(".sheet-panel")).toBeNull();
    expect(cells(root)).toHaveLength(5);
    expect(cells(root)[4]).toEqual(["Sep 12, 2026", "Books", "$1,020.50"]);
    const sheet = await saved(save);
    expect(sheet.sheets[0]!.rows![4]).toEqual(["2026-09-12", "Books", 1020.5]);
  });

  it("asks before a paste replaces filled cells: cancel, replace, or add as new rows", async () => {
    const { root, save } = owned();
    focusCell(root, 1, 1);
    paste(root, "Snacks\nTolls");
    const panel = root.querySelector(".sheet-panel")!;
    expect(panel.textContent).toContain("This paste would replace 2 filled cells.");
    click(root, "Cancel");
    expect(root.querySelector(".sheet-panel")).toBeNull();
    expect(cells(root)[0]![1]).toBe("Groceries");
    paste(root, "Snacks\nTolls");
    click(root, "Add as 2 new rows");
    expect(cells(root).map((r) => r[1])).toEqual(["Groceries", "Fuel", "Groceries", "Rent", "Snacks", "Tolls"]);
    focusCell(root, 1, 1);
    paste(root, "Snacks");
    click(root, "Replace");
    expect(cells(root)[0]![1]).toBe("Snacks");
    expect((await saved(save)).sheets[0]!.rows![0]![1]).toBe("Snacks");
  });

  it("says which pasted values do not fit, and keeps a pasted formula as text", () => {
    const { root } = owned();
    focusCell(root, 4, 1);
    paste(root, "x\tlots\n=HYPERLINK(1)\t2");
    const panel = root.querySelector(".sheet-panel")!;
    expect(panel.textContent).toContain("This paste would replace 1 filled cell.");
    click(root, "Add as 2 new rows");
    expect(root.querySelector(".sheet-panel")!.textContent).toContain('New row 1, Amount: "lots" is not a number');
    expect(cells(root)[5]![1]).toBe("=HYPERLINK(1)");
    expect(root.querySelector('td[data-row="6"][data-col="1"]')!.classList.contains("formula")).toBe(false);
  });

  it("reads an HTML table from the clipboard as text only", () => {
    const { root } = owned();
    focusCell(root, 4, 0);
    paste(root, "", "<meta charset=utf-8><table><tr><td>2026-09-20</td><td>&lt;img src=x onerror=alert(1)&gt;</td><td>5</td></tr></table>");
    click(root, "Add as a new row");
    expect(cells(root)[4]![1]).toBe("<img src=x onerror=alert(1)>");
    expect(root.querySelector("tbody img")).toBeNull();
  });

  it("pastes into a tab over a table as its updates and inserts", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ __key: 7, item: "Paint", cost: null }] });
    const writes = vi.fn().mockResolvedValue({ done: 2, results: [{ changes: 1 }, { changes: 1 }] });
    (window as { kos?: unknown }).kos = { query, write: vi.fn(), writes };
    const root = mount({ sheets: [{ name: "S", columns: [{ label: "Item", column: "item" }, { label: "Cost", column: "cost", type: "currency" }], source: { table: "supplies", key: "id" } }] });
    await vi.waitFor(() => expect(cells(root)).toHaveLength(1));
    focusCell(root, 1, 1);
    paste(root, "30\n12");
    await vi.waitFor(() => expect(writes).toHaveBeenCalledTimes(1));
    expect(writes.mock.calls[0]![0]).toEqual([
      { table: "supplies", op: "update", values: { cost: 30 }, key: { column: "id", value: 7 } },
      { table: "supplies", op: "insert", values: { cost: 12 } },
    ]);
    await vi.waitFor(() => expect(root.querySelector(".sheet-status")!.textContent).toBe("Saved 2 rows"));
  });

  it("says nothing changed when the table refuses a batch, and how many rows were already gone when it takes one", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ __key: 7, item: "Paint", cost: 1 }, { __key: 8, item: "Glue", cost: 2 }] });
    const writes = vi.fn().mockRejectedValueOnce(new Error("change 2 of 2: column not editable by this widget: cost; nothing was changed")).mockResolvedValueOnce({ done: 2, results: [{ changes: 1 }, { changes: 0 }] });
    (window as { kos?: unknown }).kos = { query, write: vi.fn(), writes };
    const root = mount({ sheets: [{ name: "S", columns: [{ label: "Item", column: "item" }, { label: "Cost", column: "cost", type: "currency" }], source: { table: "supplies", key: "id" } }] });
    await vi.waitFor(() => expect(cells(root)).toHaveLength(2));
    focusCell(root, 1, 0);
    paste(root, "Oil\nTape");
    click(root, "Replace");
    await vi.waitFor(() => expect(root.querySelector(".sheet-panel")?.textContent).toContain("Nothing was saved, so the table is as it was."));
    expect(root.querySelector(".sheet-panel")!.textContent).toContain("nothing was changed");
    expect(root.querySelector(".sheet-status")!.textContent).toBe("Not saved: nothing changed");
    focusCell(root, 1, 0);
    paste(root, "Oil\nTape");
    click(root, "Replace");
    await vi.waitFor(() => expect(root.querySelector(".sheet-status")!.textContent).toBe("Saved 1 row; 1 was already gone"));
  });

  it("imports a CSV through the file picker with a preview and a mapping, adding its rows", async () => {
    const { root, save } = owned();
    click(root, "Import CSV");
    const input = root.querySelector<HTMLInputElement>("input[type=file]")!;
    const csv = "\uFEFFAmount;Category;Date\r\n12,50;Books;03.10.2026\r\n;;\r\nlots;Gifts;2026-10-04\r\n";
    Object.defineProperty(input, "files", { value: [{ name: "october.csv", size: csv.length, arrayBuffer: () => Promise.resolve(new TextEncoder().encode(csv).buffer) }] });
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(root.querySelector(".sheet-import")).not.toBeNull());
    const panel = root.querySelector(".sheet-import")!;
    expect(panel.querySelector<HTMLSelectElement>('select[aria-label="Separator"]')!.value).toBe(";");
    expect(panel.querySelector<HTMLInputElement>("input[type=checkbox]")!.checked).toBe(true);
    expect([...panel.querySelectorAll<HTMLSelectElement>(".sheet-import-map select")].map((s) => s.value)).toEqual(["2", "1", "0"]);
    expect([...panel.querySelectorAll("tbody tr")].map((tr) => tr.textContent)).toEqual(["Oct 3, 2026Books$12.50", "Oct 4, 2026Gifts"]);
    expect(panel.textContent).toContain('File row 4, Amount: "lots" is not a number');
    // Mapping a column to nothing leaves it empty.
    const category = panel.querySelector<HTMLSelectElement>('select[aria-label="Fills Category"]')!;
    category.focus();
    category.value = "-1";
    category.dispatchEvent(new Event("change"));
    expect(root.querySelector('.sheet-import select[aria-label="Fills Category"]')).toBe(document.activeElement);
    click(root, "Add 2 rows");
    expect(cells(root)).toHaveLength(6);
    expect(cells(root)[4]).toEqual(["Oct 3, 2026", "", "$12.50"]);
    await vi.waitFor(() => expect(root.querySelector(".sheet-panel")!.textContent).toContain("Added 2 rows from october.csv. 1 value did not fit"));
    expect((await saved(save)).sheets[0]!.rows![5]).toEqual(["2026-10-04", null, null]);
  });

  it("renames, retypes, puts in and deletes columns from the column menu, asking before it deletes values", async () => {
    const { root, save } = owned();
    const open = (label: string): void => click(root, `${label}: column menu`);
    open("Category");
    expect([...root.querySelectorAll(".sheet-menu [role=menuitemradio][aria-checked=true]")].map((n) => n.textContent)).toEqual(["Text"]);
    click(root, "Rename");
    const input = root.querySelector<HTMLInputElement>(".sheet-rename")!;
    input.value = "Amount";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(root.querySelector(".sheet-status")!.textContent).toBe("Another column is called Amount");
    input.value = "Kind";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(heads(root)).toEqual(["Date", "Kind", "Amount"]);
    open("Kind");
    click(root, "Insert column right");
    const named = root.querySelector<HTMLInputElement>(".sheet-rename")!;
    expect(named.value).toBe("Column");
    named.value = "Note";
    named.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(heads(root)).toEqual(["Date", "Kind", "Note", "Amount"]);
    // An empty column goes at once; one holding values asks.
    open("Note");
    click(root, "Delete column");
    expect(heads(root)).toEqual(["Date", "Kind", "Amount"]);
    open("Kind");
    click(root, "Delete column");
    expect(root.querySelector(".sheet-panel")!.textContent).toBe("Delete the column Kind and its 4 values? Undo brings it back.Delete columnCancel");
    click(root, "Delete column");
    expect(heads(root)).toEqual(["Date", "Amount"]);
    expect(root.querySelector("tfoot")!.textContent).toContain("$1,597.50");
    open("Amount");
    click(root, "Text");
    const sheet = await saved(save);
    expect(sheet.sheets[0]!.columns).toEqual([{ label: "Date", type: "date" }, { label: "Amount", currency: "USD" }]);
    // The pivot that grouped by the deleted column says so rather than group on another.
    expect(sheet.sheets[1]!.pivot!.by).toBe("#REF!");
    expect(sheet.sheets[2]!.rows![0]![0]).toBe('=SUMIF(#REF!,"groceries",Expenses!B1:B9)');
  });

  it("puts rows in and deletes them by their numbers, asking for more than one, and undoes each", async () => {
    const { root, save } = owned();
    click(root, "Row 2");
    expect(root.querySelector(".sheet-rowbar")!.textContent).toContain("1 row picked");
    click(root, "Insert above");
    expect(cells(root).map((r) => r[1])).toEqual(["Groceries", "", "Fuel", "Groceries", "Rent"]);
    click(root, "Delete row");
    expect(cells(root)).toHaveLength(4);
    click(root, "Row 1");
    root.querySelector<HTMLButtonElement>('button[aria-label="Row 3"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    click(root, "Delete 3 rows");
    expect(root.querySelector(".sheet-panel")!.textContent).toContain("Delete 3 rows? Undo brings them back.");
    click(root.querySelector(".sheet-panel")!, "Delete 3 rows");
    expect(cells(root).map((r) => r[1])).toEqual(["Rent"]);
    click(root, "Undo");
    expect(cells(root)).toHaveLength(4);
    focusCell(root, 1, 0);
    root.querySelector("td.focus")!.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }));
    expect(cells(root)).toHaveLength(5);
    expect((await saved(save)).sheets[0]!.rows).toHaveLength(5);
  });

  it("changes no column of a tab over a table, and asks before deleting its rows, which Undo cannot bring back", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ __key: 7, item: "Paint" }, { __key: 9, item: "Glue" }] });
    const writes = vi.fn().mockResolvedValue({ done: 1, results: [{ changes: 1 }] });
    (window as { kos?: unknown }).kos = { query, write: vi.fn(), writes, save: vi.fn().mockResolvedValue({}) };
    const root = mount({ sheets: [{ name: "S", columns: [{ label: "Item", column: "item" }], source: { table: "supplies", key: "id" } }] });
    await vi.waitFor(() => expect(cells(root)).toHaveLength(2));
    click(root, "Item: column menu");
    const menu = root.querySelector(".sheet-menu")!;
    expect(menu.textContent).toContain("Its columns change with the table, by asking KOS.");
    expect(menu.textContent).not.toContain("Delete column");
    click(root, "Sort Z to A");
    click(root, "Row 2");
    expect(root.querySelector(".sheet-rowbar")!.textContent).not.toContain("Insert");
    click(root, "Delete row");
    expect(root.querySelector(".sheet-panel")!.textContent).toContain("Delete 1 row from the table supplies? Undo cannot bring it back.");
    click(root.querySelector(".sheet-panel")!, "Delete row");
    await vi.waitFor(() => expect(writes).toHaveBeenCalledWith([{ table: "supplies", op: "delete", key: { column: "id", value: 9 } }]));
  });

  it("deletes the row picked, by its key, or nothing when the table is read again in between", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ __key: 7, item: "Paint" }, { __key: 9, item: "Glue" }] });
    const writes = vi.fn().mockResolvedValue({ done: 1, results: [{ changes: 1 }] });
    const write = vi.fn().mockResolvedValue({ changes: 1 });
    (window as { kos?: unknown }).kos = { query, write, writes, save: vi.fn().mockResolvedValue({}) };
    const root = mount({ sheets: [{ name: "S", columns: [{ label: "Item", column: "item" }], source: { table: "supplies", key: "id" } }] });
    await vi.waitFor(() => expect(cells(root)).toHaveLength(2));
    click(root, "Row 2");
    click(root, "Delete row");
    expect(root.querySelector(".sheet-panel")).not.toBeNull();
    // Another edit reads the table again, its rows now the other way round: the pick and its question go.
    query.mockResolvedValue({ rows: [{ __key: 9, item: "Glue" }, { __key: 7, item: "Paint" }] });
    const td = root.querySelector<HTMLTableCellElement>('td[data-row="1"][data-col="0"]')!;
    td.dispatchEvent(new KeyboardEvent("keydown", { key: "P", bubbles: true }));
    td.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(cells(root).map((r) => r[0])).toEqual(["Glue", "Paint"]));
    expect(root.querySelector(".sheet-panel")).toBeNull();
    expect(root.querySelector(".sheet-rowbar")).toBeNull();
    expect(writes).not.toHaveBeenCalled();
    click(root, "Row 1");
    click(root, "Delete row");
    click(root.querySelector(".sheet-panel")!, "Delete row");
    await vi.waitFor(() => expect(writes).toHaveBeenCalledWith([{ table: "supplies", op: "delete", key: { column: "id", value: 9 } }]));
  });

  it("drops a pending paste and an import preview when the tab's shape changes under them", async () => {
    const { root } = owned();
    focusCell(root, 1, 1);
    paste(root, "Snacks");
    expect(root.querySelector(".sheet-panel")!.textContent).toContain("would replace");
    click(root, "Category: column menu");
    click(root, "Insert column left");
    expect(root.querySelector(".sheet-panel")).toBeNull();
    root.querySelector<HTMLInputElement>(".sheet-rename")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    click(root, "Import CSV");
    const input = root.querySelector<HTMLInputElement>("input[type=file]")!;
    const csv = "Item,Amount\nTea,4\n";
    Object.defineProperty(input, "files", { value: [{ name: "a.csv", size: csv.length, arrayBuffer: () => Promise.resolve(new TextEncoder().encode(csv).buffer) }] });
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(root.querySelector(".sheet-import")).not.toBeNull());
    click(root, "Amount: column menu");
    click(root, "Number");
    expect(root.querySelector(".sheet-import")).toBeNull();
    click(root, "Row 2");
    click(root, "Insert below");
    expect(root.querySelector(".sheet-rowbar")!.textContent).toContain("1 row picked");
    expect(root.querySelector("tr.picked")!.getAttribute("data-row")).toBe("3");
  });

  it("refuses an import into the artifact's own tab that would make it too long to save, pointing to a table", async () => {
    const { root } = owned();
    click(root, "Import CSV");
    const input = root.querySelector<HTMLInputElement>("input[type=file]")!;
    const csv = `Date,Category,Amount\n${Array.from({ length: 3000 }, (_, i) => `2026-10-01,${"A long description of a purchase ".repeat(4)}${i},12.5`).join("\n")}\n`;
    Object.defineProperty(input, "files", { value: [{ name: "big.csv", size: csv.length, arrayBuffer: () => Promise.resolve(new TextEncoder().encode(csv).buffer) }] });
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(root.querySelector(".sheet-import")).not.toBeNull());
    const panel = root.querySelector(".sheet-import")!;
    expect(panel.querySelector(".sheet-panel-refusal")!.textContent).toMatch(/past the 400 KB an artifact keeps.*project table/);
    expect([...panel.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Cancel"]);
  });

  it("picks a row from the keyboard, keeps row numbers out of the tab order, and closes the column menu on Tab", () => {
    const { root } = owned();
    expect([...root.querySelectorAll(".pick")].every((b) => b.getAttribute("tabindex") === "-1")).toBe(true);
    focusCell(root, 2, 1);
    root.querySelector("td.focus")!.dispatchEvent(new KeyboardEvent("keydown", { key: " ", shiftKey: true, bubbles: true }));
    expect(root.querySelector(".sheet-rowbar")!.textContent).toContain("1 row picked");
    expect(root.querySelector("td.editing")).toBeNull();
    focusCell(root, 3, 1);
    root.querySelector("td.focus")!.dispatchEvent(new KeyboardEvent("keydown", { key: " ", shiftKey: true, bubbles: true }));
    expect(root.querySelector(".sheet-rowbar")!.textContent).toContain("2 rows picked");
    const more = root.querySelector<HTMLButtonElement>('button[aria-label="Item: column menu"], button[aria-label="Category: column menu"]')!;
    more.click();
    expect(root.querySelector(".sheet-menu")).not.toBeNull();
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(root.querySelector(".sheet-menu")).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it("gives pasted and added rows the formula their column has", () => {
    vi.useFakeTimers();
    (window as { kos?: unknown }).kos = { save: vi.fn().mockResolvedValue({}) };
    const root = mount({ sheets: [{ name: "T", columns: [{ label: "Item" }, { label: "Cost", type: "number" }, { label: "Tax", type: "number" }], rows: [["Tea", 10, "=B1*0.1"], ["Jam", 20, "=B2*0.1"]] }] });
    focusCell(root, 2, 0);
    paste(root, "Jam\t20\nOil\t30");
    expect(cells(root)[2]).toEqual(["Oil", "30", "3"]);
    click(root, "Add row");
    expect(root.querySelector('td[data-row="4"][data-col="2"]')!.getAttribute("title")).toBe("=B4*0.1");
  });
});
