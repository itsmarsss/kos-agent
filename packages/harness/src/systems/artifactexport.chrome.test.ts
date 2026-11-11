import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findChrome } from "@kos/browser";
import type { HtmlPage } from "@kos/shared";

import { pdfText } from "../files/pdftext.js";
import { ArtifactChecker } from "./artifactcheck.js";
import { ArtifactExporter } from "./artifactexport.js";

/**
 * Exports printed and drawn by the check's own Chrome, from the dashboard's
 * build: a doc and a deck as PDF (a slide a page), and a page whose reads are
 * frozen into its HTML and answered from it when the file is opened with no
 * KOS behind it. Skipped without Chrome or the build.
 */

const here = dirname(fileURLToPath(import.meta.url));
const BUILT = resolve(here, "../../../ui/dist/page-lib");
const chrome = findChrome(undefined);

const PAGES: Record<string, HtmlPage> = {
  doc: {
    id: "doc",
    kind: "doc",
    title: "Garden water plan",
    html: `<article data-doc><header><p class="kicker">Brief</p><h1>Garden water plan</h1><p class="lede">Four rain tanks cover a third of summer watering.</p></header>${["Why", "What", "Cost", "When"].map((h) => `<h2>${h}</h2>${"<p>The tap at the gate cannot serve 42 plots, so the tanks go by the sheds, where the roofs are largest and the paths are short.</p>".repeat(6)}`).join("")}<table><tr><th>Item</th><th>Cost</th></tr><tr><td>Tanks</td><td>$4,800</td></tr></table></article>`,
  },
  deck: {
    id: "deck",
    kind: "deck",
    title: "Pitch",
    html: `<main data-deck><section class="title"><h1>Westside garden, 2027</h1><p>General meeting</p><aside class="notes">Open with the harvest.</aside></section><section><h2>Harvest rose a third</h2><p class="big">2,860 kg</p></section><section><h2>Four tanks</h2><p>By the sheds</p></section><section class="closing"><h2>Approve the water plan</h2></section></main>`,
  },
  reading: {
    id: "reading",
    title: "Reading",
    html: `<h1>Reading</h1><p id="out">waiting</p><script>kos.query("SELECT n FROM books").then(function (r) { out.textContent = r.rows.length + " books" }, function (e) { out.textContent = "failed: " + e.message })</script>`,
  },
};

describe.skipIf(!chrome || !existsSync(join(BUILT, "kos-deck.js")))("artifact exports in Chrome", () => {
  let captures: string;
  let checker: ArtifactChecker;
  let exporter: ArtifactExporter;
  const asked: string[] = [];

  beforeAll(() => {
    captures = mkdtempSync(join(tmpdir(), "kos-export-"));
    const load = (id: string): { page: HtmlPage; title: string } | undefined => (PAGES[id] ? { page: PAGES[id]!, title: PAGES[id]!.title } : undefined);
    const call = async (_id: string, _verb: "query" | "file", args: Record<string, unknown>): Promise<unknown> => {
      asked.push(String(args.sql));
      return { rows: [{ n: 1 }, { n: 2 }, { n: 3 }], truncated: false };
    };
    checker = new ArtifactChecker({ load, call, captures: (id) => join(captures, id), pageLib: () => BUILT });
    exporter = new ArtifactExporter({ load, call, browser: (work) => checker.withBrowser(work), pageLib: () => BUILT });
  });

  afterAll(() => {
    checker?.close();
    rmSync(captures, { recursive: true, force: true });
  });

  it("prints a doc on Letter pages, its text and its table in it", async () => {
    const file = await exporter.export("doc", "pdf");
    expect(file.body.subarray(0, 5).toString()).toBe("%PDF-");
    expect(file.name).toBe("Garden water plan.pdf");
    const read = await pdfText(new Uint8Array(file.body));
    expect(read.pages).toBeGreaterThanOrEqual(1);
    expect(read.text).toMatch(/Garden water plan/);
    expect(read.text).toMatch(/\$4,800/);
  }, 60_000);

  it("prints a deck a slide a page, with no bar, notes or empty page after the last", async () => {
    const file = await exporter.export("deck", "pdf");
    expect(file.body.subarray(0, 5).toString()).toBe("%PDF-");
    const read = await pdfText(new Uint8Array(file.body));
    expect(read.pages).toBe(4);
    expect(read.text).toMatch(/page 1 of 4 ---\s*Westside garden, 2027/);
    expect(read.text).toMatch(/page 4 of 4 ---\s*Approve the water plan/);
    expect(read.text).not.toMatch(/Open with the harvest|Present/);
  }, 60_000);

  it("freezes a page's reads into its HTML, answered with no KOS behind it", async () => {
    asked.length = 0;
    const file = await exporter.export("reading", "html");
    expect(asked).toEqual(["SELECT n FROM books"]);
    const html = file.body.toString("utf8");
    expect(html).toContain('"result":{"rows":[{"n":1},{"n":2},{"n":3}]');
    // Opened as a file is: the same Chrome, with no relay to KOS.
    const text = await checker.withBrowser(async ({ cdp, serve }) => {
      const { targetId } = (await cdp.send("Target.createTarget", { url: await serve(html) })) as { targetId: string };
      const { sessionId } = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
      try {
        for (let i = 0; i < 40; i++) {
          const got = (await cdp.send("Runtime.evaluate", { expression: "document.getElementById('out')?.textContent", returnByValue: true }, sessionId)) as { result: { value?: string } };
          if (got.result.value && got.result.value !== "waiting") return got.result.value;
          await new Promise((r) => setTimeout(r, 100));
        }
        return "never answered";
      } finally {
        await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
      }
    });
    expect(text).toBe("3 books");
  }, 60_000);
});
