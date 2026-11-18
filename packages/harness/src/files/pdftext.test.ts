import { describe, expect, it } from "vitest";

import { toPdf } from "../tools/pdf.js";
import { isPdf, pdfPages, pdfText } from "./pdftext.js";

describe("the words in a PDF", () => {
  it("reads a PDF back as its lines, page by page", async () => {
    // Written by KOS's own export, so the test needs no fixture on disk.
    const bytes = new Uint8Array(toPdf([{ item: "kettle", price: "42" }, { item: "toaster", price: "19" }], "Shopping"));
    expect(isPdf(bytes)).toBe(true);
    const got = await pdfText(bytes);
    expect(got.pages).toBe(1);
    expect(got.truncated).toBe(false);
    expect(got.text).toContain("Shopping");
    expect(got.text).toContain("kettle 42");
    expect(got.text).toContain("toaster 19");
  });

  it("marks the pages of a long one, and stops at the cap", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ item: `thing ${i}`, price: String(i) }));
    const bytes = new Uint8Array(toPdf(rows, "Long"));
    const whole = await pdfText(bytes);
    expect(whole.pages).toBeGreaterThan(1);
    expect(whole.text).toContain("--- page 1 of ");
    expect(whole.text).toContain("thing 199");
    const cut = await pdfText(bytes, 300);
    expect(cut.truncated).toBe(true);
    expect(cut.text.length).toBeLessThanOrEqual(310);
  });

  it("walks at most so many pages a read, saying where to read on", async () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({ item: `thing ${i}`, price: String(i) }));
    const bytes = new Uint8Array(toPdf(rows, "Long"));
    const got = await pdfText(bytes, undefined, { from: 2 }, 2);
    expect(got).toMatchObject({ from: 2, to: 3, truncated: true, next: 4 });
    expect(got.text).toContain("--- page 3 of ");
    expect(got.text).not.toContain("--- page 4 of ");
    expect(await pdfPages(bytes)).toBe(got.pages);
  });

  it("refuses what is not a PDF before opening it", async () => {
    expect(isPdf(new TextEncoder().encode("hello"))).toBe(false);
    await expect(pdfText(new TextEncoder().encode("hello"))).rejects.toThrow(/not a PDF/);
  });
});
