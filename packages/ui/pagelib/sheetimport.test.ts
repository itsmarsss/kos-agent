import type { SheetCell, SheetColumn } from "@kos/shared";
import { parseDate } from "@kos/shared/sheetformula";
import { describe, expect, it } from "vitest";

import { autoMap, clipboardRows, coerce, detectDelimiter, importRows, isHeader, parseDelimited, parseNumber, planPaste, tableFromHtml } from "./sheetimport.js";

const COLUMNS: SheetColumn[] = [{ label: "Date", type: "date" }, { label: "Item" }, { label: "Amount", type: "currency", currency: "CAD" }, { label: "Paid", type: "bool" }];

describe("delimited text", () => {
  it("reads quoted fields with delimiters, doubled quotes and line breaks, a BOM and every line ending", () => {
    expect(parseDelimited('﻿a,"b, c","say ""hi"""\r\n1,"two\nlines",3\r4,5,6\n', ",")).toEqual([
      ["a", "b, c", 'say "hi"'],
      ["1", "two\nlines", "3"],
      ["4", "5", "6"],
    ]);
    expect(parseDelimited("a;b\n;\n", ";")).toEqual([["a", "b"], ["", ""]]);
    expect(parseDelimited("x\ty", "\t")).toEqual([["x", "y"]]);
    expect(parseDelimited("", ",")).toEqual([]);
  });

  it("finds the delimiter a file splits evenly on", () => {
    expect(detectDelimiter("date,item,amount\n2026-01-02,Milk,4.5\n")).toBe(",");
    expect(detectDelimiter("date;item;amount\n02.01.2026;Milk;4,50\n")).toBe(";");
    expect(detectDelimiter("date\titem\n2026-01-02\tMilk, 2%\n")).toBe("\t");
    expect(detectDelimiter('"a, b";c\n"d, e";f\n')).toBe(";");
    expect(detectDelimiter("just one column\nhere\n")).toBe(",");
  });
});

describe("the clipboard", () => {
  it("takes the tab-separated text a spreadsheet copies, quoted cells and all", () => {
    expect(clipboardRows('2026-01-02\tMilk\t4.50\n2026-01-03\t"Bread\nand jam"\t3\n', "")).toEqual([
      ["2026-01-02", "Milk", "4.50"],
      ["2026-01-03", "Bread\nand jam", "3"],
    ]);
    // A copied blank cell at the end of the range is still a cell.
    expect(clipboardRows("a\t\n", "")).toEqual([["a", ""]]);
  });

  it("reads an HTML table as text only when there is no plain text", () => {
    const html = `<html><head><meta charset="utf-8"><style>td{color:red}</style></head><body><!--StartFragment--><google-sheets-html-origin><table><tbody>
      <tr><td>Fish &amp; chips</td><td style="x">12.50</td></tr>
      <tr><td colspan="2">wide</td><td>a<br>b &lt;script&gt;</td></tr>
      <tr><td><b>bold</b>&nbsp;and&#39;s &#x263A;</td><td></td></tr></tbody></table><!--EndFragment--></body></html>`;
    expect(tableFromHtml(html)).toEqual([
      ["Fish & chips", "12.50"],
      ["wide", "", "a\nb <script>"],
      ["bold and's ☺", ""],
    ]);
    expect(clipboardRows("", html)[0]).toEqual(["Fish & chips", "12.50"]);
    expect(clipboardRows("plain", html)).toEqual([["plain"]]);
    expect(tableFromHtml("<p>no table</p>")).toEqual([]);
  });
});

describe("values for a column", () => {
  it("reads figures as people write them", () => {
    expect(parseNumber("1,234.50", false)).toBe(1234.5);
    expect(parseNumber("1.234,50", false)).toBe(1234.5);
    expect(parseNumber("12,5", false)).toBe(12.5);
    expect(parseNumber("1.234.567", false)).toBe(1234567);
    expect(parseNumber("$ 1 200", false)).toBe(1200);
    expect(parseNumber("CAD 84.12", false)).toBe(84.12);
    expect(parseNumber("84.12 EUR", false)).toBe(84.12);
    expect(parseNumber("-€3", false)).toBe(-3);
    expect(parseNumber("(12.50)", false)).toBe(-12.5);
    expect(parseNumber("15%", true)).toBe(0.15);
    expect(parseNumber("15%", false)).toBeUndefined();
    expect(parseNumber("1e3", false)).toBe(1000);
    for (const bad of ["abc", "1.2.3,4,5", "--3", "12 apples", ""]) expect(parseNumber(bad, false), bad).toBeUndefined();
  });

  it("reads dates as people write them, into ISO", () => {
    expect(parseDate("2026-11-12")).toBe("2026-11-12");
    expect(parseDate("2026-11-12 9:05")).toBe("2026-11-12 09:05");
    expect(parseDate("2026/1/5")).toBe("2026-01-05");
    expect(parseDate("11/12/2026")).toBe("2026-11-12");
    expect(parseDate("25/12/2026")).toBe("2026-12-25");
    expect(parseDate("12.11.2026")).toBe("2026-11-12");
    expect(parseDate("1/2/26")).toBe("2026-01-02");
    expect(parseDate("Nov 12, 2026")).toBe("2026-11-12");
    expect(parseDate("Thursday, November 12, 2026")).toBe("2026-11-12");
    expect(parseDate("12 March 2026")).toBe("2026-03-12");
    expect(parseDate("12-Mar-99")).toBe("1999-03-12");
    for (const bad of ["2026-02-30", "13/13/2026", "soon", "2026", "Foo 12, 2026"]) expect(parseDate(bad), bad).toBeUndefined();
  });

  it("coerces by the column's type and says why a value does not fit", () => {
    expect(coerce(" 2,400.10 ", COLUMNS[2])).toEqual({ cell: 2400.1 });
    expect(coerce("Nov 3, 2026", COLUMNS[0])).toEqual({ cell: "2026-11-03" });
    expect(coerce("yes", COLUMNS[3])).toEqual({ cell: true });
    expect(coerce("No", COLUMNS[3])).toEqual({ cell: false });
    expect(coerce("", COLUMNS[2])).toEqual({ cell: null });
    expect(coerce("Milk", COLUMNS[1])).toEqual({ cell: "Milk" });
    expect(coerce("lots", COLUMNS[2])).toEqual({ error: '"lots" is not a number' });
    expect(coerce("someday", COLUMNS[0])).toEqual({ error: '"someday" is not a date' });
    expect(coerce("maybe", COLUMNS[3])).toEqual({ error: '"maybe" is not yes or no' });
  });

  it("never lets what comes in become a formula", () => {
    expect(coerce('=HYPERLINK("x")', COLUMNS[1])).toEqual({ cell: `'=HYPERLINK("x")` });
    expect(coerce("=1+2", COLUMNS[2])).toEqual({ error: '"=1+2" is a formula, and what comes in is kept as values' });
    expect(coerce("<img src=x onerror=alert(1)>", COLUMNS[1])).toEqual({ cell: "<img src=x onerror=alert(1)>" });
  });
});

describe("mapping and importing", () => {
  it("knows the tab's own header and maps by its names, else in order", () => {
    expect(isHeader(["date", "ITEM", "Amount", ""], COLUMNS)).toBe(true);
    expect(isHeader(["2026-01-02", "Milk", "4"], COLUMNS)).toBe(false);
    expect(autoMap(["amount", "what", "date"], 3, COLUMNS)).toEqual([2, -1, 0, -1]);
    expect(autoMap(undefined, 3, COLUMNS)).toEqual([0, 1, 2, -1]);
    expect(autoMap(["x", "y"], 2, COLUMNS)).toEqual([0, 1, -1, -1]);
    expect(autoMap(["id"], 1, [{ label: "Key", column: "id" }])).toEqual([0]);
  });

  it("adds a file's rows by the mapping, skipping blank lines and naming each value that does not fit", () => {
    const rows = parseDelimited("Amount,Item,Date\n4.50,Milk,2026-01-02\n,,\nlots,Bread,Jan 3 2026\n", ",");
    const got = importRows(rows, true, autoMap(rows[0], 3, COLUMNS), COLUMNS);
    expect(got.rows).toEqual([
      ["2026-01-02", "Milk", 4.5, null],
      ["2026-01-03", "Bread", null, null],
    ]);
    expect(got.errors).toEqual(['Row 4, Amount: "lots" is not a number']);
  });
});

describe("a paste", () => {
  const rows: SheetCell[][] = [
    ["2026-01-02", "Milk", 4.5, null],
    ["2026-01-03", null, null, null],
  ];
  const at = (row: number, col: number): SheetCell => rows[row - 1]?.[col] ?? null;

  it("fills empty cells down the rows shown and adds rows past the last, without asking", () => {
    const plan = planPaste([["Bread", "3"], ["Eggs", "6.25"], ["Jam", "4"]], [2], 1, COLUMNS, at);
    expect(plan.cells).toEqual([
      { row: 2, col: 1, cell: "Bread" },
      { row: 2, col: 2, cell: 3 },
    ]);
    expect(plan.added).toEqual([
      [null, "Eggs", 6.25, null],
      [null, "Jam", 4, null],
    ]);
    expect(plan.replaces).toBe(0);
  });

  it("counts the filled cells it would replace, and leaves one it would not change alone", () => {
    const plan = planPaste([["Oat milk", "4.5"]], [1, 2], 1, COLUMNS, at);
    expect(plan.replaces).toBe(1);
    expect(plan.cells).toEqual([{ row: 1, col: 1, cell: "Oat milk" }]);
  });

  it("follows the rows as shown, not as stored", () => {
    const plan = planPaste([["a"], ["b"]], [2, 1], 1, COLUMNS, at);
    expect(plan.cells.map((c) => c.row)).toEqual([2, 1]);
  });

  it("maps a block led by the tab's header by its names and adds its rows", () => {
    const plan = planPaste([["Item", "Amount"], ["Tea", "$7"]], [1, 2], 3, COLUMNS, at);
    expect(plan.cells).toEqual([]);
    expect(plan.added).toEqual([[null, "Tea", 7, null]]);
  });

  it("names what does not fit and what reaches past the last column", () => {
    const plan = planPaste([["x", "=SUM(A1:A9)", "extra"]], [3], 2, COLUMNS, at);
    expect(plan.errors).toEqual(['Row 1, Amount: "x" is not a number', 'Row 1, Paid: "=SUM(A1:A9)" is a formula, and what comes in is kept as values']);
    expect(plan.dropped).toBe(1);
    // A new row with nothing that fits in it is not added.
    expect(plan.added).toEqual([]);
  });
});
