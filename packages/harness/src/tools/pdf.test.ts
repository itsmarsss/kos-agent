import { describe, expect, it } from "vitest";

import { tableLines, toPdf } from "./pdf.js";

describe("a table as a PDF", () => {
  it("lays the table out in aligned monospace, with a title", () => {
    const lines = tableLines([{ note: "coffee", amount: 12.5 }, { note: "groceries", amount: 40 }], "Spending");
    expect(lines[0]).toBe("Spending");
    expect(lines[2]).toBe("note       amount");
    expect(lines[4]).toBe("coffee     12.5  ");
    expect(lines[5]).toBe("groceries  40    ");
  });

  it("writes a file a PDF reader will open: header, objects, an xref that points at them", () => {
    const pdf = toPdf([{ a: "x (y)", b: "é ∑" }], "T");
    const text = pdf.toString("latin1");
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("/Type /Catalog");
    expect(text).toContain("/Count 1");
    // Parentheses are escaped, Latin-1 kept, the rest marked rather than mangled.
    expect(text).toContain("(x \\(y\\)  ");
    expect(text).toContain("é ?");
    // Every xref offset lands on the object it names.
    const start = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(start, start + 4)).toBe("xref");
    const entries = [...text.slice(start).matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
    entries.forEach((at, i) => {
      expect(text.slice(at, at + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
    });
  });

  it("pages a long table and numbers the pages", () => {
    const rows = Array.from({ length: 150 }, (_, i) => ({ n: i }));
    const text = toPdf(rows).toString("latin1");
    expect(text).toContain("/Count 3");
    expect(text).toContain("(3 / 3) Tj");
  });
});
