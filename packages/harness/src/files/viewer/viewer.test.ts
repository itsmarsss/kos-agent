import { existsSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { convert, runRequest } from "./convert.js";
import type { DocView, SheetView, SlidesView } from "@kos/shared";
import { hostileDocx, keynote, sampleDeck, sampleDocx, sampleWorkbook, zipBomb } from "./office.fixture.js";
import { textutilProfile } from "./macos.js";
import { builtChild, childJobs, officeRunner } from "./run.js";
import { ROWS_MAX } from "./sheets.js";
import { OfficeViewer, type ViewerHost } from "./viewer.js";

const inProcess: ViewerHost = { run: async (req) => runRequest(req) };

describe("Word documents", () => {
  it("keeps headings, formatting, lists, a merged table and an inline picture", () => {
    const view = convert(sampleDocx(), "docx") as DocView;
    expect(view.kind).toBe("doc");
    expect(view.html).toContain("<h1>Garden plan</h1>");
    expect(view.html).toContain("<h1>Spring beds</h1>");
    expect(view.html).toContain("<strong>tomatoes</strong>");
    expect(view.html).toMatch(/<em><span style="color:#C0392B">last frost<\/span><\/em>/);
    expect(view.html).toContain('style="text-align:justify"');
    expect(view.html).toMatch(/<ul><li>Seeds<ul><li>Basil<\/li><\/ul><\/li><li>Soil<\/li><\/ul>\n<ol><li>Dig<\/li><li>Sow<\/li><\/ol>/);
    expect(view.html).toMatch(/<td rowspan="2"><p>Bed<\/p><\/td>/);
    expect(view.html).toMatch(/<td colspan="2"><p>Total<\/p><\/td>/);
    expect(view.html).toMatch(/<img src="data:image\/png;base64,[A-Za-z0-9+/=]+" alt="" width="100">/);
    expect(view.notes).toEqual([]);
  });

  it("shows a document's words as words, loads nothing from outside and keeps no link", () => {
    const view = convert(hostileDocx(), "docx") as DocView;
    expect(view.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(view.html).not.toMatch(/<script|<[^>]*onerror|<img src="x|https:\/\/tracker|href=|javascript:/);
    expect(view.html).toContain("click me");
    expect(view.notes).toContain("Pictures linked from outside the document are not loaded.");
  });

  it("refuses a zip bomb rather than inflating it", () => {
    expect(() => convert(zipBomb("word/document.xml", 80 * 1024 * 1024), "docx")).toThrow(/refused: .* inflates past/);
  });

  it("refuses an archive whose parts together inflate past the cap", async () => {
    const { writeZip } = await import("../zip.js");
    const zeros = new Uint8Array(50 * 1024 * 1024);
    const many = writeZip({ "word/document.xml": "<w:document/>", a: zeros, b: zeros, c: zeros, d: zeros }, { deflate: true });
    expect(() => convert(many, "docx")).toThrow(/refused: it inflates past 160 MB/);
  });

  it("refuses a file that is not what its name says", () => {
    expect(() => convert(new TextEncoder().encode("plain words"), "docx")).toThrow(/not what its name says/);
  });
});

describe("sheets", () => {
  it("reads a workbook's tabs with values as the file formats them, numbers marked", () => {
    for (const format of ["xlsx", "xls", "ods"] as const) {
      const view = convert(sampleWorkbook(format), format) as SheetView;
      expect(view.sheets.map((s) => s.name)).toEqual(["Budget", "Notes"]);
      const [head, first] = view.sheets[0]!.rows;
      expect(head?.map((c) => c?.v)).toEqual(["Item", "Cost", "When"]);
      expect(first?.[1]).toEqual({ v: format === "ods" ? "12.5" : "$12.50", t: "n" });
      expect(first?.[2]?.v).toMatch(/^\d+\/\d+\/26$|^2026-/);
    }
  });

  it("cuts a huge sheet at its cap and says how much was shown", () => {
    const view = convert(sampleWorkbook("xlsx", ROWS_MAX + 500), "xlsx") as SheetView;
    expect(view.sheets[0]!.rows).toHaveLength(ROWS_MAX);
    expect(view.sheets[0]!.totalRows).toBe(ROWS_MAX + 500);
    expect(view.notes.join(" ")).toMatch(/Budget: showing the first 2,000 of 2,500 rows/);
  });

  it("reads CSV by the rules, never reinterpreting a value", () => {
    const view = convert(new TextEncoder().encode('﻿name,zip,note\r\n"Smith, J",0123,"said ""hi""\nthen left"\nLee,90210,\n'), "csv") as SheetView;
    expect(view.sheets[0]!.rows).toEqual([
      [{ v: "name", t: "s" }, { v: "zip", t: "s" }, { v: "note", t: "s" }],
      [{ v: "Smith, J", t: "s" }, { v: "0123", t: "n" }, { v: 'said "hi"\nthen left', t: "s" }],
      [{ v: "Lee", t: "s" }, { v: "90210", t: "n" }, null],
    ]);
    const tsv = convert(new TextEncoder().encode("a\tb\n1\t2\n"), "tsv") as SheetView;
    expect(tsv.sheets[0]!.rows[1]).toEqual([{ v: "1", t: "n" }, { v: "2", t: "n" }]);
  });

  it("refuses a workbook zip bomb before SheetJS inflates it, whatever the file is named", () => {
    for (const format of ["xlsx", "xls", "ods", "numbers", "csv"] as const) expect(() => convert(zipBomb("xl/workbook.xml", 80 * 1024 * 1024), format), format).toThrow(/refused/);
  });

  it("refuses a file whose bytes and name disagree", () => {
    expect(() => convert(sampleWorkbook("xlsx"), "xls")).toThrow(/a \.xls file holding a zip archive/);
    expect(() => convert(sampleWorkbook("xls"), "xlsx")).toThrow(/a \.xlsx file holding an Office 97 file/);
    expect(() => convert(sampleDocx(), "xlsx")).toThrow(/not what its name says/);
    expect(() => convert(sampleWorkbook("xlsx"), "csv")).toThrow(/not what its name says/);
  });
});

describe("decks", () => {
  it("draws slides with inherited placeholders, sizes, colours, pictures, boxes and notes", () => {
    const view = convert(sampleDeck(), "pptx") as SlidesView;
    expect(view.aspect).toBeCloseTo(4 / 3);
    expect(view.slides.map((s) => s.title)).toEqual(["Garden 2026", "What to plant"]);
    const [cover, second] = view.slides;
    expect(cover!.background).toBe("#fff8e1");
    const coverTitle = cover!.shapes[0]!;
    expect(coverTitle).toMatchObject({ kind: "text", anchor: "middle", paragraphs: [{ align: "center", runs: [{ text: "Garden 2026" }] }] });
    expect(coverTitle.x).toBeCloseTo(457200 / 9144000);
    if (coverTitle.kind === "text") expect(coverTitle.paragraphs[0]!.runs[0]!.size).toBeCloseTo((44 * 12700) / 9144000);
    const body = second!.shapes.find((s) => s.kind === "text" && s.paragraphs[0]?.runs[0]?.text === "Tomatoes");
    expect(body).toMatchObject({ paragraphs: [{ bullet: true, runs: [{ bold: true }] }, { level: 1, runs: [{ color: "#4472c4" }] }] });
    expect(second!.shapes.find((s) => s.kind === "picture")).toMatchObject({ src: expect.stringMatching(/^data:image\/png;base64,/) });
    expect(second!.shapes.find((s) => s.kind === "box")).toMatchObject({ fill: "#2e7d32" });
    expect(second!.notes).toBe("Mention the frost date.");
    expect(view.notes).toContain("Pictures linked from outside the deck are not loaded.");
  });

  it("shows a Keynote file by the preview it keeps", () => {
    const view = convert(keynote(), "key");
    expect(view).toMatchObject({ kind: "picture", src: "data:image/jpeg;base64,/9j/4AECAw==" });
  });
});

describe("OfficeViewer", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kos-viewer-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("converts each version of a file once", async () => {
    const run = vi.fn(inProcess.run);
    const viewer = new OfficeViewer({ run });
    const file = join(dir, "plan.docx");
    writeFileSync(file, sampleDocx());
    const [a, b] = await Promise.all([viewer.view(file, "plan.docx"), viewer.view(file, "plan.docx")]);
    expect(a).toBe(b);
    await viewer.view(file, "plan.docx");
    expect(run).toHaveBeenCalledTimes(1);
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    await viewer.view(file, "plan.docx");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("reads old Word files through textutil and cleans what it says", async () => {
    const textutil = vi.fn(async () => '<html><head><style>p.p1 {font: 12px Times; background: url(https://x.example/a.png)}</style><script>alert(1)</script></head><body><p class="p1" onclick="x()">Hello</p><img src="file:///etc/passwd"></body></html>');
    const viewer = new OfficeViewer({ ...inProcess, textutil });
    writeFileSync(join(dir, "old.doc"), "x");
    const view = (await viewer.view(join(dir, "old.doc"), "old.doc")) as DocView;
    expect(textutil).toHaveBeenCalledWith(expect.any(Uint8Array), "doc");
    expect(view.html).toBe('<style>p.p1 {font: 12px Times;}</style><p class="p1">Hello</p>');
    await expect(new OfficeViewer(inProcess).view(join(dir, "old.doc"), "old.doc")).rejects.toThrow(/textutil, which this host does not have/);
  });

  it("keeps textutil to its own copy: no network, no writes, no one's files, nothing else run", () => {
    const profile = textutilProfile(dir);
    expect(profile).toContain("(deny network*)(deny file-write*)");
    expect(profile).toMatch(/\(deny file-read\* \(subpath "\/Users"\) \(subpath "\/Volumes"\) \(subpath "\/private\/var\/folders"\)/);
    expect(profile).toContain("(deny mach-lookup)");
    expect(profile).toContain(`(allow file-read* (subpath "${realpathSync(dir)}"))`);
    expect(profile).toContain('(deny process-exec)(allow process-exec (literal "/usr/bin/textutil"))');
  });

  it("does not open an old deck at all: it is a file to download", async () => {
    writeFileSync(join(dir, "talk.ppt"), "x");
    await expect(new OfficeViewer(inProcess).view(join(dir, "talk.ppt"), "talk.ppt")).rejects.toThrow(/not a document KOS shows/);
  });

  it("refuses a file past the size cap and a name it does not show", async () => {
    const big = join(dir, "big.xlsx");
    writeFileSync(big, Buffer.alloc(31 * 1024 * 1024));
    await expect(new OfficeViewer(inProcess).view(big, "big.xlsx")).rejects.toThrow(/past the 30 MB/);
    await expect(new OfficeViewer(inProcess).view(big, "big.exe")).rejects.toThrow(/not a document/);
  });
});

describe("the bounded run", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kos-child-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const script = (body: string): string => {
    const file = join(dir, "child.mjs");
    writeFileSync(file, body);
    return file;
  };

  it("stops a child that never answers", async () => {
    const run = childJobs(script("setInterval(() => {}, 1000);"), { timeoutMs: 400 });
    await expect(run({ op: "sanitize", html: "", format: "doc" })).rejects.toThrow(/more than 0.4 s/);
  });

  it("stops a child whose buffers grow past the ceiling, though its heap stays small", async () => {
    const run = childJobs(script("const kept = []; process.once('message', () => { const t = setInterval(() => { kept.push(Buffer.alloc(32 * 1024 * 1024, 1)); }, 20); });"), { rssMb: 200, timeoutMs: 15_000 });
    await expect(run({ op: "sanitize", html: "", format: "doc" })).rejects.toThrow(/needed more than 200 MB/);
  });

  it("stops a child that spins past its CPU seconds, by the kernel's limit", async () => {
    const run = childJobs(script("process.once('message', () => { for (;;) {} });"), { cpuSeconds: 1, timeoutMs: 15_000 });
    await expect(run({ op: "sanitize", html: "", format: "doc" })).rejects.toThrow(/share of the processor/);
  });

  it("stops a child when its job is superseded", async () => {
    const run = childJobs(script("setInterval(() => {}, 1000);"), { timeoutMs: 15_000 });
    const ask = new AbortController();
    const pending = run({ op: "sanitize", html: "", format: "doc" }, ask.signal);
    setTimeout(() => ask.abort(), 100);
    await expect(pending).rejects.toThrow(/superseded/);
  });

  it("runs two at a time", async () => {
    const run = childJobs(script("process.once('message', () => setTimeout(() => process.send({ ok: true, value: { at: Date.now() } }, () => process.exit(0)), 300));"));
    const started = Date.now();
    await Promise.all([1, 2, 3].map(() => run({ op: "sanitize", html: "", format: "doc" })));
    expect(Date.now() - started).toBeGreaterThan(550);
  });

  const built = fileURLToPath(new URL("../../../dist/files/viewer/child.js", import.meta.url));
  it.skipIf(!existsSync(built))("converts in the built child, and refuses a bomb there", async () => {
    expect(builtChild()).toBeUndefined();
    const run = officeRunner(childJobs(built));
    const view = (await run({ op: "convert", bytes: sampleDocx(), format: "docx" })) as DocView;
    expect(view.html).toContain("<h1>Garden plan</h1>");
    await expect(run({ op: "convert", bytes: zipBomb("xl/workbook.xml", 80 * 1024 * 1024), format: "xls" })).rejects.toThrow(/refused/);
  });
});

describe("the XML reader", () => {
  it("reads deep nesting without recursion, and refuses a runaway tag", async () => {
    const { find, parseXml, textOf } = await import("./xml.js");
    const deep = `${"<a>".repeat(50_000)}<b>x</b>${"</a>".repeat(50_000)}`;
    const root = parseXml(deep);
    expect(textOf(root)).toBe("x");
    expect(find(root, "b")).toHaveLength(1);
    expect(() => parseXml(`<a x="${"y".repeat(70_000)}"/>`)).toThrow(/64 KB/);
  });
});
