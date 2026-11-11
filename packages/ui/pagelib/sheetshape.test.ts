import type { SheetBook } from "@kos/shared";
import { Workbook, rewriteRefs } from "@kos/shared/sheetformula";
import { describe, expect, it } from "vitest";

import { deleteColumn, deleteRows, freshLabel, insertColumn, insertRows, renameColumn, retypeColumn } from "./sheetshape.js";

const book = (): SheetBook => ({
  sheets: [
    {
      name: "Expenses",
      freeze: 2,
      columns: [{ label: "Date", type: "date" }, { label: "Item" }, { label: "Amount", type: "currency", currency: "CAD" }, { label: "Tax", type: "currency", currency: "CAD" }],
      rows: [
        ["2026-01-02", "Milk", 4.5, "=C1*0.13"],
        ["2026-01-03", "Bread", 3, "=C2*0.13"],
        ["2026-01-04", "Jam", 6, "=SUM($C$1:C2)"],
      ],
      totals: { Amount: "sum", D: "sum" },
    },
    { name: "Check", columns: [{ label: "x", type: "number" }], rows: [["=SUM(Expenses!C1:C3)"], ["='Expenses'!D3"]] },
    { name: "By item", columns: [], pivot: { from: "Expenses", by: "B", values: [{ column: "Amount", fn: "sum" }] } },
  ],
  charts: [{ type: "bar", title: "Spend", labels: "B1:B3", values: "C1:C3" }],
});

describe("rewriting references", () => {
  it("moves each reference as it is told, keeping $ marks and tab names, and writes #REF! for one that went", () => {
    const right = (r: { col: number; col2?: number }): typeof r => ({ ...r, col: r.col + 1, ...(r.col2 !== undefined ? { col2: r.col2 + 1 } : {}) });
    expect(rewriteRefs("=SUM($A$1:B2)+Other!C3*'My tab'!$D4", right)).toBe("=SUM($B$1:C2)+Other!D3*'My tab'!$E4");
    expect(rewriteRefs('=A1&"A1"', () => null)).toBe('=#REF!&"A1"');
    expect(rewriteRefs("=Other!A1+1", () => null)).toBe("=#REF!+1");
    expect(rewriteRefs("plain A1", right)).toBe("plain A1");
    expect(rewriteRefs('=SUM("unclosed', right)).toBe('=SUM("unclosed');
  });

  it("works out a deleted reference as #REF!", () => {
    const wb = new Workbook({ sheets: [{ name: "T", columns: [{ label: "a" }], rows: [["=#REF!+1"]] }] });
    expect(wb.value(0, 1, 0)).toMatchObject({ error: "#REF!" });
  });
});

describe("columns", () => {
  it("puts a column in, moving formulas, totals, pivots, charts and the freeze after it", () => {
    const b = book();
    insertColumn(b, 0, 1, { label: "Store" });
    const [tab, check, pivot] = b.sheets;
    expect(tab!.columns.map((c) => c.label)).toEqual(["Date", "Store", "Item", "Amount", "Tax"]);
    expect(tab!.rows![0]).toEqual(["2026-01-02", null, "Milk", 4.5, "=D1*0.13"]);
    expect(tab!.rows![2]![4]).toBe("=SUM($D$1:D2)");
    expect(tab!.totals).toEqual({ Amount: "sum", E: "sum" });
    expect(tab!.freeze).toBe(3);
    expect(check!.rows).toEqual([["=SUM(Expenses!D1:D3)"], ["='Expenses'!E3"]]);
    expect(pivot!.pivot!.by).toBe("C");
    expect(b.charts![0]).toMatchObject({ labels: "C1:C3", values: "D1:D3" });
    // What it worked out before, it works out still.
    expect(new Workbook(b).value(1, 1, 0)).toBe(13.5);
  });

  it("takes a column out, its references #REF!, its total gone, what is after it moved back", () => {
    const b = book();
    deleteColumn(b, 0, 2);
    const [tab, check] = b.sheets;
    expect(tab!.columns.map((c) => c.label)).toEqual(["Date", "Item", "Tax"]);
    expect(tab!.rows![0]).toEqual(["2026-01-02", "Milk", "=#REF!*0.13"]);
    expect(tab!.totals).toEqual({ C: "sum" });
    expect(check!.rows).toEqual([["=SUM(#REF!)"], ["='Expenses'!C3"]]);
    expect(b.charts![0]).toMatchObject({ labels: "B1:B3", values: "#REF!" });
    expect(new Workbook(b).value(1, 1, 0)).toMatchObject({ error: "#REF!" });
  });

  it("shrinks a range that loses one of its columns", () => {
    const b: SheetBook = { sheets: [{ name: "T", columns: [{ label: "a" }, { label: "b" }, { label: "c" }, { label: "s" }], rows: [[1, 2, 3, "=SUM(A1:C1)"]] }] };
    deleteColumn(b, 0, 1);
    expect(b.sheets[0]!.rows![0]).toEqual([1, 3, "=SUM(A1:B1)"]);
    expect(new Workbook(b).value(0, 1, 2)).toBe(4);
  });

  it("renames a column and what names it, a source column still reading its table column", () => {
    const b = book();
    renameColumn(b, 0, 2, "Cost");
    expect(b.sheets[0]!.totals).toEqual({ Cost: "sum", D: "sum" });
    expect(b.sheets[2]!.pivot!.values[0]!.column).toBe("Cost");
    const src: SheetBook = { sheets: [{ name: "S", columns: [{ label: "amount" }], source: { table: "t", key: "id" } }] };
    renameColumn(src, 0, 0, "Amount (CAD)");
    expect(src.sheets[0]!.columns[0]).toEqual({ label: "Amount (CAD)", column: "amount" });
  });

  it("retypes a column, reading its text as the new type and counting what does not read", () => {
    const b: SheetBook = { sheets: [{ name: "T", columns: [{ label: "When" }, { label: "Cost", type: "currency", currency: "EUR" }], rows: [["Nov 3, 2026", 1], ["soon", 2], ["=TODAY()", 3]] }] };
    expect(retypeColumn(b, 0, 0, "date")).toEqual({ unread: 1 });
    expect(b.sheets[0]!.rows!.map((r) => r[0])).toEqual(["2026-11-03", "soon", "=TODAY()"]);
    retypeColumn(b, 0, 0, "currency");
    expect(b.sheets[0]!.columns[0]).toEqual({ label: "When", type: "currency", currency: "EUR" });
    retypeColumn(b, 0, 0, "text");
    expect(b.sheets[0]!.columns[0]!.type).toBeUndefined();
  });

  it("finds a label no column has", () => {
    expect(freshLabel([{ label: "Column" }, { label: "column 2" }], "Column")).toBe("Column 3");
    expect(freshLabel([], "Notes")).toBe("Notes");
  });
});

describe("rows", () => {
  it("puts rows in, moving the references below them and widening a range they land in", () => {
    const b = book();
    insertRows(b, 0, 2, [[null, null, null, null]]);
    const tab = b.sheets[0]!;
    expect(tab.rows!.map((r) => r[3])).toEqual(["=C1*0.13", null, "=C3*0.13", "=SUM($C$1:C3)"]);
    expect(b.sheets[1]!.rows![0]).toEqual(["=SUM(Expenses!C1:C4)"]);
    expect(b.charts![0]).toMatchObject({ values: "C1:C4" });
  });

  it("appends past the last row without touching a range that ends there", () => {
    const b = book();
    insertRows(b, 0, 4, [["2026-01-05", "Tea", 2, null]]);
    expect(b.sheets[0]!.rows).toHaveLength(4);
    expect(b.sheets[1]!.rows![0]).toEqual(["=SUM(Expenses!C1:C3)"]);
  });

  it("takes rows out in any order, a reference to one #REF!, a range shrunk", () => {
    const b = book();
    deleteRows(b, 0, [3, 1]);
    const tab = b.sheets[0]!;
    expect(tab.rows).toEqual([["2026-01-03", "Bread", 3, "=C1*0.13"]]);
    expect(b.sheets[1]!.rows).toEqual([["=SUM(Expenses!C1:C1)"], ["=#REF!"]]);
    expect(new Workbook(b).value(1, 1, 0)).toBe(3);
  });
});
