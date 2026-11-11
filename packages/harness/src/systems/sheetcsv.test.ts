import type { SheetBook } from "@kos/shared";
import { describe, expect, it } from "vitest";

import { tabCsv, withSources } from "./sheetcsv.js";

const BOOK: SheetBook = {
  sheets: [
    {
      name: "Expenses",
      columns: [{ label: "Date", type: "date" }, { label: "Category" }, { label: "Amount", type: "currency", currency: "CAD" }, { label: "Share", type: "percent" }],
      rows: [
        ["2026-10-01", "Housing", 1650, "=C1/SUM(C1:C3)"],
        ["2026-10-02", 'Food, "fresh"', 56.5, "=C2/SUM(C1:C3)"],
        ["2026-10-04", "=NOPE(1)", "=C2*2", "=C3/0"],
      ],
      totals: { Amount: "sum" },
    },
    { name: "By category", columns: [], pivot: { from: "Expenses", by: "Category", values: [{ column: "Amount", fn: "sum" }] } },
  ],
};

const lines = (csv: string): string[] => csv.replace(/^﻿/, "").split("\r\n");

describe("a sheet's tab as CSV", () => {
  it("leads with a BOM, writes labels then values worked out (an error as its code), CRLF between rows, and no totals", () => {
    const csv = tabCsv(BOOK, 0);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(lines(csv)).toEqual([
      "Date,Category,Amount,Share",
      `2026-10-01,Housing,1650,${Number((1650 / 1819.5).toPrecision(15))}`,
      `2026-10-02,"Food, ""fresh""",56.5,${Number((56.5 / 1819.5).toPrecision(15))}`,
      "2026-10-04,#NAME?,113,#DIV/0!",
      "",
    ]);
  });

  it("writes a number to the fifteen digits a spreadsheet keeps", () => {
    const book: SheetBook = { sheets: [{ name: "T", columns: [{ label: "n", type: "number" }], rows: [["=56.37+112.74"]] }] };
    expect(lines(tabCsv(book, 0))[1]).toBe("169.11");
  });

  it("writes a pivot as its groups", () => {
    expect(lines(tabCsv(BOOK, 1))[0]).toBe("Category,Amount");
    expect(lines(tabCsv(BOOK, 1))).toContain("Housing,1650");
  });

  it("guards text a spreadsheet would run, but leaves a negative number a number", () => {
    const book: SheetBook = { sheets: [{ name: "T", columns: [{ label: "a" }, { label: "b", type: "number" }], rows: [["+1 sum", -4], ["@me", "-3"], ["-x", true], ["a\nb", null]] }] };
    expect(lines(tabCsv(book, 0))).toEqual(["a,b", "'+1 sum,-4", "'@me,-3", "'-x,TRUE", '"a\nb",', ""]);
  });

  it("reads a source tab's rows through the bridge, by its own query, in its column order", async () => {
    const asked: string[] = [];
    const book: SheetBook = { sheets: [{ name: "Live", columns: [{ label: "When", column: "date" }, { label: "amount", type: "currency" }, { label: "Double", type: "number" }], source: { table: "budget_tx", key: "id" } }] };
    const filled = await withSources(book, async (sql) => {
      asked.push(sql);
      return { rows: [{ __key: 1, date: "2026-10-01", amount: 12 }] };
    });
    expect(asked).toEqual(['SELECT "id" AS __key, "date", "amount", "Double" FROM "budget_tx"']);
    expect(lines(tabCsv(filled, 0))).toEqual(["When,amount,Double", "2026-10-01,12,", ""]);
    await expect(withSources({ sheets: [{ ...book.sheets[0]!, source: { table: "x y", key: "id" } }] }, async () => ({ rows: [] }))).rejects.toThrow(/no plain table/);
  });
});
