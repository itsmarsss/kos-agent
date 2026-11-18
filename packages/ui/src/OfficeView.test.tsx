// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OfficeView } from "@kos/shared";

import { api } from "./api.js";
import { OfficeBody, columnName, docDocument, isOfficePath } from "./OfficeView.js";

/** The viewers draw what the server converted: a sheet's tabs and grid, a deck's slides, a document in its sealed frame. */

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", class {
    observe(): void {}
    disconnect(): void {}
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const show = (view: OfficeView): void => {
  vi.spyOn(api, "officeView").mockResolvedValue(view);
  render(<OfficeBody path="f" />);
};

describe("the Office viewers", () => {
  it("know which files are theirs and name columns as a spreadsheet does", () => {
    expect(["a.docx", "b.XLSX", "c.key", "d.csv", "e.ppt"].every(isOfficePath)).toBe(true);
    expect(["a.pdf", "b.md", "docx"].some(isOfficePath)).toBe(false);
    expect([0, 25, 26, 27, 701, 702].map(columnName)).toEqual(["A", "Z", "AA", "AB", "ZZ", "AAA"]);
  });

  it("draw a workbook as tabs over a grid: a header row held, figures to the right, merges spanned", async () => {
    show({
      kind: "sheet",
      format: "xlsx",
      notes: ["Budget: showing the first 2,000 of 9,000 rows."],
      sheets: [
        { name: "Budget", cols: 3, totalRows: 3, totalCols: 3, rows: [[{ v: "Item", t: "s" }, { v: "Cost", t: "s" }, null], [{ v: "Seeds", t: "s" }, { v: "$12.50", t: "n" }, { v: "TRUE", t: "b" }], [{ v: "Both", t: "s" }, null, null]], merges: [{ r: 2, c: 0, rows: 1, cols: 3 }] },
        { name: "Notes", cols: 1, totalRows: 1, totalCols: 1, rows: [[{ v: "Water daily", t: "s" }]] },
      ],
    });
    expect(await screen.findByText("Budget: showing the first 2,000 of 9,000 rows.")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Budget" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Item").tagName).toBe("TH");
    expect(screen.getByText("Cost").className).toBe("num");
    expect(screen.getByText("$12.50").className).toBe("num");
    expect(screen.getByText("Both").getAttribute("colspan")).toBe("3");
    fireEvent.click(screen.getByRole("tab", { name: "Notes" }));
    expect(await screen.findByText("Water daily")).toBeTruthy();
  });

  it("draw a deck's slides at their shape, words sized to the slide", async () => {
    show({
      kind: "slides",
      format: "pptx",
      aspect: 16 / 9,
      notes: [],
      slides: [{ title: "Garden", background: "#fff8e1", notes: "Say hello.", shapes: [{ kind: "text", x: 0.1, y: 0.2, w: 0.8, h: 0.3, anchor: "middle", paragraphs: [{ align: "center", runs: [{ text: "Garden", size: 0.05, bold: true, color: "#112233" }] }] }, { kind: "picture", x: 0, y: 0, w: 1, h: 1, src: "data:image/png;base64,AA==" }] }],
    });
    const slide = await screen.findByRole("img", { name: "Garden" });
    expect(slide.style.background).toContain("rgb(255, 248, 225)");
    const words = screen.getByText("Garden", { selector: "span" });
    expect(words.style.fontSize).toBe("calc(5cqw)");
    expect(words.style.fontWeight).toBe("700");
    expect((words.closest(".ov-shape") as HTMLElement).style.left).toBe("10%");
    expect(screen.getByText("Say hello.")).toBeTruthy();
  });

  it("seal a document's frame: no script, no network, nothing but data pictures", () => {
    const doc = docDocument("<p>x</p>", "#0c0e12");
    expect(doc).toContain(`content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"`);
    expect(doc).toContain(":root{--ground:#0c0e12}");
    expect(docDocument("<p>x</p>", "red;}</style><script>")).not.toContain("<script>");
  });

  it("say why a file could not be drawn", async () => {
    vi.spyOn(api, "officeView").mockRejectedValue(new Error("a .doc file is read by macOS's textutil, which this host does not have; download it to open it"));
    render(<OfficeBody path="old.doc" />);
    expect(await screen.findByText(/textutil, which this host does not have/)).toBeTruthy();
  });
});
