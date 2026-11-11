import { SHEET_ROWS_MAX, type SheetBook } from "./artifacts.js";
import { describe, expect, it, vi } from "vitest";

import { Workbook, aggregate, columnIndex, columnLetter, findColumn, formatValue, isError, literalOf, meets, parseFormula, sortValue, sourceQuery, totalsRow, type Value } from "./sheetformula.js";

/** A one-tab workbook of these rows, every column a number unless typed. */
function book(rows: (string | number | boolean | null)[][], extra: Partial<SheetBook> = {}): Workbook {
  const width = Math.max(...rows.map((r) => r.length), 1);
  return new Workbook({
    sheets: [{ name: "Main", columns: Array.from({ length: width }, (_, i) => ({ label: columnLetter(i), type: "number" as const })), rows }],
    ...extra,
  });
}

/** The value of a formula put in its own cell under the rows. */
function calc(formula: string, rows: (string | number | boolean | null)[][] = [[]]): Value {
  const width = Math.max(...rows.map((r) => r.length), 1);
  const wb = book([...rows, [formula, ...Array(width - 1).fill(null)]]);
  return wb.value(0, rows.length + 1, 0);
}

describe("addresses", () => {
  it("turns letters into columns and back", () => {
    expect(columnIndex("A")).toBe(0);
    expect(columnIndex("z")).toBe(25);
    expect(columnIndex("AA")).toBe(26);
    expect(columnLetter(0)).toBe("A");
    expect(columnLetter(27)).toBe("AB");
    for (const n of [0, 5, 25, 26, 51, 52, 701, 702]) expect(columnIndex(columnLetter(n))).toBe(n);
  });

  it("finds a column by label before letter", () => {
    const cols = [{ label: "Date" }, { label: "B" }, { label: "Amount" }];
    expect(findColumn(cols, "amount")).toBe(2);
    expect(findColumn(cols, "b")).toBe(1);
    expect(findColumn(cols, "A")).toBe(0);
    expect(findColumn(cols, "Z")).toBe(-1);
  });
});

describe("parsing and precedence", () => {
  it("multiplies before adding and groups with parentheses", () => {
    expect(calc("=1+2*3")).toBe(7);
    expect(calc("=(1+2)*3")).toBe(9);
    expect(calc("=10-4-3")).toBe(3);
    expect(calc("=2^3^2")).toBe(512);
    expect(calc("=8/4/2")).toBe(1);
  });

  it("binds unary minus tighter than a power, as spreadsheets do", () => {
    expect(calc("=-2^2")).toBe(4);
    expect(calc("=0-2^2")).toBe(-4);
    expect(calc("=--3")).toBe(3);
  });

  it("joins text after arithmetic and compares last", () => {
    expect(calc('="a"&1+1')).toBe("a2");
    expect(calc("=1+1=2")).toBe(true);
    expect(calc('="b">"A"')).toBe(true);
    expect(calc("=3<>3")).toBe(false);
    expect(calc("=2<=2")).toBe(true);
  });

  it("reads strings with doubled quotes, decimals and booleans", () => {
    expect(calc('="say ""hi"""')).toBe('say "hi"');
    expect(calc("=.5+1.25")).toBe(1.75);
    expect(calc("=1e3")).toBe(1000);
    expect(calc("=TRUE")).toBe(true);
  });

  it("gives #NAME? for broken syntax and unknown names", () => {
    for (const f of ["=1+", "=SUM(1", "=FOO(1)", "=1 2", "=bar", '="open']) {
      const v = calc(f);
      expect(isError(v) && v.error).toBe("#NAME?");
    }
  });

  it("parses references, ranges and absolute markers", () => {
    expect(parseFormula("=$B$2")).toEqual({ k: "ref", col: 1, row: 2 });
    expect(parseFormula("=C9:A1")).toEqual({ k: "range", col: 0, row: 1, col2: 2, row2: 9 });
    expect(parseFormula("='By category'!B2")).toEqual({ k: "ref", sheet: "By category", col: 1, row: 2 });
    expect(parseFormula("=Data!A1:A3")).toMatchObject({ k: "range", sheet: "Data" });
  });
});

describe("references", () => {
  it("reads cells and ranges, rows from 1", () => {
    const rows = [
      [10, 1],
      [20, 2],
      [30, 3],
    ];
    expect(calc("=A1+B3", rows)).toBe(13);
    expect(calc("=SUM(A1:A3)", rows)).toBe(60);
    expect(calc("=SUM(A1:B3)", rows)).toBe(66);
    expect(calc("=AVERAGE(A1:A3)", rows)).toBe(20);
    expect(calc("=MIN(A1:A3)+MAX(B1:B3)", rows)).toBe(13);
  });

  it("follows formulas through other formulas", () => {
    const wb = book([[2, "=A1*3"], ["=B1+1", "=A2*A1"]]);
    expect(wb.value(0, 1, 1)).toBe(6);
    expect(wb.value(0, 2, 0)).toBe(7);
    expect(wb.value(0, 2, 1)).toBe(14);
  });

  it("names a cycle instead of looping", () => {
    const wb = book([["=B1", "=A1"], ["=A2+1", 1]]);
    expect(wb.value(0, 1, 0)).toMatchObject({ error: "#CYCLE!" });
    expect(wb.value(0, 2, 0)).toMatchObject({ error: "#CYCLE!" });
    expect(wb.value(0, 2, 1)).toBe(1);
  });

  it("works out a chain as long as a sheet may be, each row reading the one above", () => {
    const rows = Array.from({ length: SHEET_ROWS_MAX }, (_, i) => (i === 0 ? [1, "=A1"] : [`=A${i}+1`, `=B${i}+A${i + 1}`]));
    const wb = book(rows);
    expect(wb.value(0, SHEET_ROWS_MAX, 0)).toBe(SHEET_ROWS_MAX);
    expect(wb.value(0, SHEET_ROWS_MAX, 1)).toBe((SHEET_ROWS_MAX * (SHEET_ROWS_MAX + 1)) / 2);
    expect(wb.values(0)).toHaveLength(SHEET_ROWS_MAX);
    // Read from the top down, too, as the grid draws it.
    expect(book(rows).values(0).at(-1)).toEqual([SHEET_ROWS_MAX, (SHEET_ROWS_MAX * (SHEET_ROWS_MAX + 1)) / 2]);
  });

  it("names a cycle as long as a sheet may be without running out of stack", () => {
    const rows = Array.from({ length: SHEET_ROWS_MAX }, (_, i) => [i === 0 ? `=A${SHEET_ROWS_MAX}` : `=A${i}+1`]);
    const wb = book(rows);
    expect(wb.value(0, SHEET_ROWS_MAX, 0)).toMatchObject({ error: "#CYCLE!" });
    expect(wb.value(0, 1, 0)).toMatchObject({ error: "#CYCLE!" });
  });

  it("makes a formula that fails as it is worked out that cell's error, and frees the cell", () => {
    const wb = book([[2, "=A1*3", "=B1+1"]]);
    const call = vi.spyOn(Workbook.prototype as unknown as { binary: () => Value }, "binary").mockImplementationOnce(() => {
      throw new Error("the engine broke");
    });
    expect(wb.value(0, 1, 2)).toMatchObject({ error: "#VALUE!" });
    call.mockRestore();
    expect((wb as unknown as { busy: Set<string> }).busy.size).toBe(0);
  });

  it("is not a cycle when the branch that would close it is never taken", () => {
    const wb = book([["=IF(TRUE, 1, B1)", "=A1+1"]]);
    expect(wb.value(0, 1, 0)).toBe(1);
    expect(wb.value(0, 1, 1)).toBe(2);
  });

  it("gives #REF! outside the sheet and for a missing tab", () => {
    expect(calc("=Z1", [[1]])).toMatchObject({ error: "#REF!" });
    expect(calc("=Nope!A1", [[1]])).toMatchObject({ error: "#REF!" });
    expect(calc("=SUM(A1:Z2)", [[1]])).toMatchObject({ error: "#REF!" });
  });

  it("treats rows past the end as empty", () => {
    expect(calc("=A40+1", [[1]])).toBe(1);
  });

  it("reads another tab, quoted or not", () => {
    const wb = new Workbook({
      sheets: [
        { name: "Data", columns: [{ label: "x", type: "number" }], rows: [[4], [6]] },
        { name: "Sum up", columns: [{ label: "total", type: "number" }], rows: [["=SUM(Data!A1:A2)"], ["='Sum up'!A1*2"]] },
      ],
    });
    expect(wb.value(1, 1, 0)).toBe(10);
    expect(wb.value(1, 2, 0)).toBe(20);
  });
});

describe("functions", () => {
  const rows: (string | number)[][] = [
    ["food", 12],
    ["fuel", 40],
    ["Food", 8],
    ["rent", 900],
  ];
  const typed = (formula: string): Value => {
    const wb = new Workbook({
      sheets: [{ name: "T", columns: [{ label: "cat" }, { label: "amt", type: "number" }, { label: "out", type: "number" }], rows: [...rows.map((r) => [...r, null]), [null, null, formula]] }],
    });
    return wb.value(0, rows.length + 1, 2);
  };

  it("sums, counts and averages by a criterion", () => {
    expect(typed('=SUMIF(A1:A4,"food",B1:B4)')).toBe(20);
    expect(typed('=COUNTIF(A1:A4,"food")')).toBe(2);
    expect(typed('=AVERAGEIF(A1:A4,"food",B1:B4)')).toBe(10);
    expect(typed('=SUMIF(B1:B4,">20")')).toBe(940);
    expect(typed('=COUNTIF(B1:B4,"<=12")')).toBe(2);
    expect(typed('=COUNTIF(A1:A4,"<>food")')).toBe(2);
    expect(typed('=AVERAGEIF(A1:A4,"none",B1:B4)')).toMatchObject({ error: "#DIV/0!" });
  });

  it("counts numbers and filled cells", () => {
    expect(typed("=COUNT(A1:B4)")).toBe(4);
    expect(typed("=COUNTA(A1:B4)")).toBe(8);
  });

  it("rounds half away from zero and takes absolute values", () => {
    expect(calc("=ROUND(2.345,2)")).toBe(2.35);
    expect(calc("=ROUND(-2.5)")).toBe(-3);
    expect(calc("=ROUND(1234,-2)")).toBe(1200);
    expect(calc("=ABS(-4)")).toBe(4);
  });

  it("chooses with IF and joins with CONCAT", () => {
    expect(calc('=IF(1>2,"yes","no")')).toBe("no");
    expect(calc("=IF(0,1)")).toBe(false);
    expect(calc('=CONCAT("a",1,TRUE)')).toBe("a1TRUE");
  });

  it("names the error: division by zero, text as a number, wrong arity", () => {
    expect(calc("=1/0")).toMatchObject({ error: "#DIV/0!" });
    expect(calc('="x"+1')).toMatchObject({ error: "#VALUE!" });
    expect(calc("=ABS(1,2)")).toMatchObject({ error: "#VALUE!" });
    expect(calc("=A1:A2+1", [[1], [2]])).toMatchObject({ error: "#VALUE!" });
  });

  it("passes an error along", () => {
    expect(calc("=(1/0)+1")).toMatchObject({ error: "#DIV/0!" });
    expect(calc("=SUM(A1:A2)", [["=1/0"], [2]])).toMatchObject({ error: "#DIV/0!" });
  });
});

describe("lookups", () => {
  const people: (string | number | null)[][] = [
    ["ada", 36, "London"],
    ["grace", 85, "New York"],
    ["linus", 54, "Helsinki"],
  ];
  /** A formula over a three-column table of names, ages and cities, put under it. */
  const over = (formula: string): Value => {
    const wb = new Workbook({
      sheets: [{ name: "P", columns: [{ label: "Name" }, { label: "Age", type: "number" }, { label: "City" }, { label: "Out" }], rows: [...people.map((r) => [...r, null]), [null, null, null, formula]] }],
    });
    return wb.value(0, people.length + 1, 3);
  };

  it("finds a row with VLOOKUP, exact or nearest below", () => {
    expect(over('=VLOOKUP("Grace",A1:C3,3,FALSE)')).toBe("New York");
    expect(over('=VLOOKUP("bob",A1:C3,2,FALSE)')).toMatchObject({ error: "#N/A" });
    expect(over("=VLOOKUP(60,B1:C3,2,FALSE)")).toMatchObject({ error: "#N/A" });
    // Approximate by default, on a sorted first column: the last at or below.
    expect(calc("=VLOOKUP(25,A1:B3,2)", [[0, 1], [20, 2], [50, 3]])).toBe(2);
    expect(calc("=VLOOKUP(-1,A1:B3,2)", [[0, 1], [20, 2], [50, 3]])).toMatchObject({ error: "#N/A" });
    expect(over('=VLOOKUP("ada",A1:C3,4,FALSE)')).toMatchObject({ error: "#REF!" });
    expect(over('=VLOOKUP("ada",A1:C3,0,FALSE)')).toMatchObject({ error: "#VALUE!" });
  });

  it("finds with XLOOKUP, falling back, nearest, from the end and by wildcard", () => {
    expect(over('=XLOOKUP("linus",A1:A3,C1:C3)')).toBe("Helsinki");
    expect(over('=XLOOKUP("bob",A1:A3,C1:C3,"nobody")')).toBe("nobody");
    expect(over('=XLOOKUP("bob",A1:A3,C1:C3)')).toMatchObject({ error: "#N/A" });
    expect(over("=XLOOKUP(60,B1:B3,A1:A3,,-1)")).toMatchObject({ error: "#NAME?" });
    expect(over('=XLOOKUP(60,B1:B3,A1:A3,"none",-1)')).toBe("linus");
    expect(over('=XLOOKUP(60,B1:B3,A1:A3,"none",1)')).toBe("grace");
    expect(over('=XLOOKUP("g*",A1:A3,B1:B3,"none",2)')).toBe(85);
    expect(over('=XLOOKUP("?da",A1:A3,B1:B3,"none",2)')).toBe(36);
    expect(calc('=XLOOKUP("a",A1:A3,B1:B3,"none",0,-1)', [["a", 1], ["b", 2], ["a", 3]])).toBe(3);
    expect(over("=XLOOKUP(36,B1:B3,A1:A2)")).toMatchObject({ error: "#VALUE!" });
  });

  it("indexes and matches", () => {
    expect(over('=INDEX(C1:C3,MATCH("grace",A1:A3,0))')).toBe("New York");
    expect(over("=INDEX(A1:C3,3,2)")).toBe(54);
    expect(over("=INDEX(A1:C1,2)")).toBe(36);
    expect(over("=INDEX(A1:C3,4,1)")).toMatchObject({ error: "#REF!" });
    expect(over("=INDEX(A1:C3,2)")).toMatchObject({ error: "#VALUE!" });
    expect(over("=INDEX(A1:A3,0)")).toMatchObject({ error: "#VALUE!" });
    // A row inside the range but past the data is empty, not outside it.
    expect(over("=INDEX(A1:A20,10)")).toBe(null);
    expect(over("=MATCH(54,B1:B3,0)")).toBe(3);
    expect(calc("=MATCH(25,A1:A3)", [[10], [20], [30]])).toBe(2);
    expect(calc("=MATCH(25,A1:A3,-1)", [[30], [20], [10]])).toBe(1);
    expect(over('=MATCH("zed",A1:A3,0)')).toMatchObject({ error: "#N/A" });
    expect(over("=MATCH(1,A1:C3,0)")).toMatchObject({ error: "#N/A" });
  });
});

describe("dates", () => {
  const clock = (): Date => new Date(2026, 10, 11, 9, 30, 5);
  /** A formula's value with the rows typed as given, read on a fixed clock. */
  const at = (formula: string, rows: (string | number | null)[][] = [[]], type: "date" | "number" | "text" = "number"): Value => {
    const width = Math.max(...rows.map((r) => r.length), 1);
    const wb = new Workbook(
      { sheets: [{ name: "D", columns: Array.from({ length: width }, (_, i) => ({ label: columnLetter(i), type })), rows: [...rows, [formula, ...Array(width - 1).fill(null)]] }] },
      { now: clock },
    );
    return wb.value(0, rows.length + 1, 0);
  };

  it("reads TODAY and NOW from the clock it is given, once for the workbook", () => {
    expect(at("=TODAY()")).toBe("2026-11-11");
    expect(at("=NOW()")).toBe("2026-11-11 09:30:05");
    expect(at("=TODAY(1)")).toMatchObject({ error: "#VALUE!" });
    let reads = 0;
    const wb = new Workbook({ sheets: [{ name: "D", columns: [{ label: "a" }, { label: "b" }], rows: [["=NOW()", "=NOW()"]] }] }, { now: () => new Date(2026, 0, 1, 0, 0, reads++) });
    expect(wb.value(0, 1, 0)).toBe(wb.value(0, 1, 1));
    expect(reads).toBe(1);
  });

  it("makes a date and takes one apart", () => {
    expect(at("=DATE(2026,2,29)")).toBe("2026-03-01");
    expect(at("=DATE(2026,13,1)")).toBe("2027-01-01");
    expect(at("=DATE(99,1,1)")).toBe("1999-01-01");
    expect(at("=DATE(10000,1,1)")).toMatchObject({ error: "#NUM!" });
    expect(at("=YEAR(A1)", [["2024-02-29"]], "date")).toBe(2024);
    expect(at("=MONTH(A1)", [["2024-02-29"]], "date")).toBe(2);
    expect(at("=DAY(A1)", [["2024-02-29"]], "date")).toBe(29);
    expect(at('=YEAR("soon")')).toMatchObject({ error: "#VALUE!" });
    expect(at('=DAY("2026-02-30")')).toMatchObject({ error: "#VALUE!" });
    expect(at("=YEAR(TODAY())")).toBe(2026);
  });

  it("subtracts dates to days and adds days to a date", () => {
    expect(at("=B1-A1", [["2026-01-01", "2026-03-01"]], "date")).toBe(59);
    expect(at("=TODAY()-A1", [["2026-11-01"]], "date")).toBe(10);
    const plus = at("=A1+7", [["2026-12-28"]], "date");
    expect(formatValue(plus, { label: "d", type: "date" })).toBe("Jan 4, 2027");
    expect(at("=A1>DATE(2026,1,1)", [["2026-06-01"]], "date")).toBe(true);
  });

  it("counts whole units between dates with DATEDIF", () => {
    const span = (a: string, b: string, unit: string): Value => at(`=DATEDIF(A1,B1,"${unit}")`, [[a, b]], "date");
    expect(span("2020-05-15", "2026-11-11", "Y")).toBe(6);
    expect(span("2020-05-15", "2026-11-11", "M")).toBe(77);
    expect(span("2026-01-31", "2026-03-01", "M")).toBe(1);
    expect(span("2026-01-01", "2026-03-01", "D")).toBe(59);
    expect(span("2020-05-15", "2026-11-11", "YM")).toBe(5);
    expect(span("2026-01-31", "2026-03-01", "MD")).toBe(1);
    expect(span("2026-01-10", "2026-03-04", "MD")).toBe(22);
    expect(span("2020-05-15", "2026-11-11", "YD")).toBe(180);
    expect(span("2026-03-01", "2026-01-01", "D")).toMatchObject({ error: "#NUM!" });
    expect(span("2026-01-01", "2026-03-01", "W")).toMatchObject({ error: "#NUM!" });
  });
});

describe("more functions", () => {
  it("takes the median", () => {
    expect(calc("=MEDIAN(A1:A4)", [[4], [1], [3], [2]])).toBe(2.5);
    expect(calc("=MEDIAN(5,1,9)")).toBe(5);
    expect(calc("=MEDIAN(A1:A2)", [[null], [null]])).toMatchObject({ error: "#NUM!" });
    expect(calc("=MEDIAN(A1:A2)", [["=1/0"], [1]])).toMatchObject({ error: "#DIV/0!" });
  });

  it("catches an error with IFERROR and passes a value through", () => {
    expect(calc('=IFERROR(1/0,"none")')).toBe("none");
    expect(calc("=IFERROR(4/2,0)")).toBe(2);
    expect(calc('=IFERROR(VLOOKUP(9,A1:B1,2,FALSE),"missing")', [[1, 2]])).toBe("missing");
    expect(calc("=IFERROR(1)")).toMatchObject({ error: "#VALUE!" });
  });

  it("rounds up and down, away from and toward zero", () => {
    expect(calc("=ROUNDUP(2.341,2)")).toBe(2.35);
    expect(calc("=ROUNDUP(-2.341,1)")).toBe(-2.4);
    expect(calc("=ROUNDUP(1201,-2)")).toBe(1300);
    expect(calc("=ROUNDDOWN(2.349,2)")).toBe(2.34);
    expect(calc("=ROUNDDOWN(-2.349,1)")).toBe(-2.3);
    expect(calc("=ROUNDDOWN(1.1*3,1)")).toBe(3.3);
    expect(calc("=ROUNDUP(2.5)")).toMatchObject({ error: "#VALUE!" });
    expect(calc('=ROUNDUP("x",1)')).toMatchObject({ error: "#VALUE!" });
  });

  it("joins text with a delimiter, skipping empty cells when asked", () => {
    expect(calc('=TEXTJOIN(", ",TRUE,A1:A3)', [["a"], [null], ["c"]])).toBe("a, c");
    expect(calc('=TEXTJOIN("-",FALSE,A1:A3)', [["a"], [null], ["c"]])).toBe("a--c");
    expect(calc('=TEXTJOIN("",TRUE,"x",1,TRUE)')).toBe("x1TRUE");
    expect(calc('=TEXTJOIN(",",TRUE)')).toMatchObject({ error: "#VALUE!" });
  });

  it("cuts, measures, cases and trims text", () => {
    expect(calc('=LEFT("Groceries",4)')).toBe("Groc");
    expect(calc('=LEFT("Groceries")')).toBe("G");
    expect(calc('=RIGHT("Groceries",3)')).toBe("ies");
    expect(calc('=RIGHT("abc",0)')).toBe("");
    expect(calc('=RIGHT("abc",10)')).toBe("abc");
    expect(calc('=MID("Groceries",3,4)')).toBe("ocer");
    expect(calc('=MID("abc",5,2)')).toBe("");
    expect(calc('=LEN("hello")')).toBe(5);
    expect(calc("=LEN(A1)", [[null]])).toBe(0);
    expect(calc("=LEFT(1234.5,2)")).toBe("12");
    expect(calc('=UPPER("ab")&LOWER("CD")')).toBe("ABcd");
    expect(calc('=TRIM("  two   words ")')).toBe("two words");
    expect(calc('=LEFT("abc",-1)')).toMatchObject({ error: "#VALUE!" });
    expect(calc('=MID("abc",0,1)')).toMatchObject({ error: "#VALUE!" });
    expect(calc("=LEN(1/0)")).toMatchObject({ error: "#DIV/0!" });
  });

  it("keeps text led by an apostrophe and an equals sign as text", () => {
    const wb = new Workbook({ sheets: [{ name: "T", columns: [{ label: "a" }, { label: "b" }], rows: [["'=SUM(1,2)", "=LEN(A1)"]] }] });
    expect(wb.value(0, 1, 0)).toBe("=SUM(1,2)");
    expect(wb.value(0, 1, 1)).toBe(9);
  });
});

describe("values and criteria", () => {
  it("reads numeric text in a numeric column", () => {
    expect(literalOf("1,234.50", { label: "x", type: "currency" })).toBe(1234.5);
    expect(literalOf("$12", { label: "x", type: "currency" })).toBe(12);
    expect(literalOf("15%", { label: "x", type: "percent" })).toBe(0.15);
    expect(literalOf("12", { label: "x" })).toBe("12");
    expect(literalOf("yes", { label: "x", type: "bool" })).toBe(true);
    expect(literalOf("", { label: "x" })).toBe(null);
  });

  it("matches criteria the way SUMIF does", () => {
    expect(meets(5, ">4")).toBe(true);
    expect(meets("5", ">4")).toBe(true);
    expect(meets("Food", "food")).toBe(true);
    expect(meets("food", "=fuel")).toBe(false);
    expect(meets(3, 3)).toBe(true);
    expect(meets(null, "<>x")).toBe(true);
  });

  it("sorts numbers by size and empties last", () => {
    expect([10, null, 9, 100].sort(sortValue)).toEqual([9, 10, 100, null]);
    expect(["b", "A", "c"].sort(sortValue)).toEqual(["A", "b", "c"]);
  });
});

describe("totals and pivots", () => {
  it("aggregates a column", () => {
    expect(aggregate("sum", [1, 2, null, "x"])).toBe(3);
    expect(aggregate("average", [2, 4])).toBe(3);
    expect(aggregate("count", [1, null, "", "x"])).toBe(2);
    expect(aggregate("max", [])).toBe(0);
  });

  it("totals the columns named by label or letter", () => {
    const columns = [{ label: "Item" }, { label: "Cost", type: "currency" as const }, { label: "Qty", type: "number" as const }];
    expect(totalsRow(columns, { Cost: "sum", C: "average" }, [["a", 2, 1], ["b", 3, 3]])).toEqual([undefined, 5, 2]);
  });

  it("groups a tab by a column, largest first", () => {
    const wb = new Workbook({
      sheets: [
        {
          name: "Expenses",
          columns: [{ label: "Category" }, { label: "Amount", type: "currency", currency: "CAD" }],
          rows: [["Food", 10], ["Rent", 900], ["food", 15], ["Fuel", "=20+5"]],
        },
        { name: "By category", columns: [], pivot: { from: "Expenses", by: "Category", values: [{ column: "Amount", fn: "sum" }, { column: "B", fn: "count" }] } },
        { name: "Check", columns: [{ label: "x", type: "number" }], rows: [["=SUM('By category'!B1:B9)"]] },
      ],
    });
    expect(wb.columns(1).map((c) => c.label)).toEqual(["Category", "Amount", "Count of Amount"]);
    expect(wb.columns(1)[1]!.currency).toBe("CAD");
    expect(wb.values(1)).toEqual([
      ["Rent", 900, 1],
      ["Food", 25, 2],
      ["Fuel", 25, 1],
    ]);
    expect(wb.value(2, 1, 0)).toBe(950);
  });

  it("reads a range for a chart", () => {
    const wb = book([[1], [2], [3]]);
    expect(wb.range(undefined, "A1:A3")).toEqual([1, 2, 3]);
    expect(wb.range("Nope", "A1:A3")).toMatchObject({ error: "#REF!" });
  });
});

describe("formats", () => {
  it("shows money, percents and numbers with their places", () => {
    expect(formatValue(1234.5, { label: "x", type: "currency", currency: "USD" })).toBe("$1,234.50");
    expect(formatValue(-3, { label: "x", type: "currency", currency: "EUR", decimals: 0 })).toBe("-€3");
    expect(formatValue(0.256, { label: "x", type: "percent" })).toBe("25.6%");
    expect(formatValue(0.25, { label: "x", type: "percent", decimals: 0 })).toBe("25%");
    expect(formatValue(1234.5678, { label: "x", type: "number" })).toBe("1,234.57");
    expect(formatValue(3, { label: "x", type: "number", decimals: 2 })).toBe("3.00");
  });

  it("shows dates from ISO, booleans and errors", () => {
    expect(formatValue("2026-09-01", { label: "d", type: "date" })).toBe("Sep 1, 2026");
    expect(formatValue("soon", { label: "d", type: "date" })).toBe("soon");
    expect(formatValue(true, { label: "b", type: "bool" })).toBe("Yes");
    expect(formatValue({ error: "#REF!", why: "x" }, undefined)).toBe("#REF!");
    expect(formatValue(null, undefined)).toBe("");
  });
});

describe("a source tab", () => {
  it("reads a source table with quoted names and a safe order", () => {
    const tab = { name: "T", columns: [{ label: "When", column: "date" }, { label: "amount" }], source: { table: "budget_tx", key: "id", orderBy: "date desc" } };
    expect(sourceQuery(tab)).toBe('SELECT "id" AS __key, "date", "amount" FROM "budget_tx" ORDER BY "date" DESC');
    expect(sourceQuery({ ...tab, source: { ...tab.source, orderBy: "date; drop" } })).toBe('SELECT "id" AS __key, "date", "amount" FROM "budget_tx"');
    expect(sourceQuery({ ...tab, source: { table: "x y", key: "id" } })).toBeUndefined();
  });
});
