import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findChrome } from "@kos/browser";
import { COLOURS, type HtmlPage } from "@kos/shared";

import { ArtifactChecker, reportWords, type Finding } from "./artifactcheck.js";

/**
 * artifacts.check in a real Chrome, on pages planted with one problem each,
 * and on a page written the way the guide says, which must come back clean:
 * a check that cries wolf teaches the agent to ignore it. Skipped without
 * Chrome.
 */

const here = dirname(fileURLToPath(import.meta.url));
const KIT = resolve(here, "../../../kit/src");

/** A page-lib folder as the dashboard's build makes it, with only what a page needs. */
function pageLib(): string {
  const dir = mkdtempSync(join(tmpdir(), "kos-pagelib-"));
  mkdirSync(join(dir, "fonts"));
  writeFileSync(join(dir, "frame.css"), `${readFileSync(join(KIT, "kit.css"), "utf8")}\n${readFileSync(join(KIT, "page.css"), "utf8")}`);
  const dark = Object.fromEntries(Object.entries(COLOURS).map(([k, v]) => [`--${k}`, v]));
  const light = { ...dark, "--bg": "#f4f5f8", "--panel": "#ffffff", "--panel-2": "#eceef3", "--line": "#dde1e8", "--text": "#161a22", "--muted": "#58607a", "--accent": "#3558d6", "--on-accent": "#ffffff" };
  writeFileSync(join(dir, "tokens.json"), JSON.stringify({ dark, light }));
  return dir;
}

/** A page written to the guide: a token plan for both themes, nothing literal, nothing empty. */
const GOOD = `<style>
:root{--paper:#fbfaf7;--ink:#1d2330;--quiet:#5a6275;--rule:#d9dce3;--mark:#2f5bd3}
@media (prefers-color-scheme: dark){:root:not([data-theme=light]){--paper:#11141b;--ink:#e6e9f0;--quiet:#9aa3b5;--rule:#2a303c;--mark:#86a4ff}}
:root[data-theme=dark]{--paper:#11141b;--ink:#e6e9f0;--quiet:#9aa3b5;--rule:#2a303c;--mark:#86a4ff}
body{background:var(--paper);color:var(--ink);padding:24px 16px;margin:0}
main{max-width:640px;margin:0 auto;display:flex;flex-direction:column;gap:12px}
p{color:var(--quiet)} .entry{border:1px solid var(--rule);padding:12px;color:var(--ink)}
</style><main><h1>Garden log</h1><a id="jump" href="#days">Jump to the days</a><p>Watering, week of 3 November.</p><div class="entry">Tomatoes: 2 L on Monday</div><table id="days"><tr><th>Day</th><th>Litres</th></tr><tr><td>Mon</td><td>2</td></tr></table></main>
<script>jump.click();kos.query("SELECT 1 AS n").then(function(r){document.querySelector("p").textContent += " " + r.rows.length + " row."})</script>`;

const PLANTED: Record<string, { html: string; expect: Finding["kind"] }> = {
  wide: { html: `<h1>Wide</h1><div class="strip" style="width:1800px;height:40px;background:var(--panel)">a strip</div>`, expect: "overflow" },
  // Too wide only for a phone: caught only if the phone render is laid out at the phone's width.
  narrow: { html: `<h1>Narrow</h1><div class="strip" style="width:600px;height:40px;background:var(--panel)">a strip</div>`, expect: "overflow" },
  // Tiles too narrow for their words, which a hidden overflow cuts off: the page does not scroll, it just loses text.
  cramped: { html: `<h1>Cramped</h1><div style="display:flex;gap:8px"><div class="tile" style="width:40px;overflow:hidden;white-space:nowrap;border:1px solid var(--line)">Total spent this month</div></div>`, expect: "clipped" },
  // Rows scrolled out of a box are not drawn over what follows it: no overlap there.
  scrolled: { html: `<h1>Scrolled</h1><div style="max-height:60px;overflow:auto"><p>one</p><p>two</p><p>three</p><p>four</p><p>five</p></div><p>After the box</p><p>And more after it</p>`, expect: "none" as never },
  stacked: { html: `<h1>Stacked</h1><div style="position:relative;height:60px"><p class="label" style="position:absolute;top:0;left:0;margin:0">Total spent</p><p class="value" style="position:absolute;top:4px;left:10px;margin:0">$3,340.87</p></div>`, expect: "overlap" },
  literal: { html: `<style>body{background:#ffffff;color:#222222}</style><h1>Literal</h1><p>One</p><p>Two</p><p>Three</p><p>Four</p><p>Five</p><p>Six</p>`, expect: "theme" },
  faint: { html: `<h1>Faint</h1><p class="faint" style="color:#8a8a8a;background:#9a9a9a">hard to read</p>`, expect: "contrast" },
  noisy: { html: `<h1>Noisy</h1><script>console.error("the chart had no data"); null.x;</script>`, expect: "console" },
  refused: { html: `<h1>Refused</h1><div id="out">waiting</div><script>kos.query("SELECT * FROM nowhere").then(function(){}, function(e){out.textContent = "none"})</script>`, expect: "bridge" },
  hollow: { html: `<h1>Hollow</h1><div class="chart" style="width:320px;height:180px;border:1px solid var(--line)"></div>`, expect: "empty" },
  untitled: { html: `<p>Just a line of text, no heading.</p>`, expect: "title" },
  formula: { html: `<h1>Sheet</h1><table><tr><td>#REF!</td></tr></table>`, expect: "formula" },
  leaving: { html: `<h1>Leaving</h1><script>setTimeout(function(){ var a = document.createElement("a"); a.href = "https://example.com/x"; document.body.append(a); a.click(); }, 50)</script>`, expect: "left" },
};

const chrome = findChrome(undefined);

describe.skipIf(!chrome)("artifacts.check in Chrome", () => {
  let lib: string;
  let captures: string;
  let checker: ArtifactChecker;
  const pages: Record<string, HtmlPage> = {};

  beforeAll(() => {
    lib = pageLib();
    captures = mkdtempSync(join(tmpdir(), "kos-captures-"));
    pages.good = { id: "good", title: "Garden log", html: GOOD };
    for (const [id, p] of Object.entries(PLANTED)) pages[id] = { id, title: id, html: p.html };
    checker = new ArtifactChecker({
      load: (id) => (pages[id] ? { page: pages[id]!, title: pages[id]!.title } : undefined),
      call: async (_id, verb, args) => {
        if (verb === "query" && /nowhere/.test(String(args.sql))) throw new Error("the query cannot run here");
        return { rows: [{ n: 1 }], truncated: false };
      },
      captures: (id) => join(captures, id),
      pageLib: () => lib,
    });
  });

  afterAll(() => {
    checker?.close();
    rmSync(lib, { recursive: true, force: true });
    rmSync(captures, { recursive: true, force: true });
  });

  it("finds nothing wrong with a page written to the guide (whose #id link scrolls, not leaves), and keeps its four captures", async () => {
    const report = await checker.check("good");
    expect(report.findings).toEqual([]);
    for (const k of ["desktop-light", "desktop-dark", "phone-light", "phone-dark"] as const) expect(existsSync(report.captures[k])).toBe(true);
    expect(reportWords(report)).toMatch(/Nothing to fix.*do not check again/);
    const tool = await checker.tool("good");
    expect(tool.images).toHaveLength(2);
  }, 45_000);

  it.each(Object.entries(PLANTED))("reports the planted problem in %s", async (id, planted) => {
    const report = await checker.check(id);
    const kinds = report.findings.map((f) => f.kind);
    if ((planted.expect as string) === "none") return void expect(report.findings).toEqual([]);
    expect(kinds).toContain(planted.expect);
    if (planted.expect === "overflow") expect(report.findings.find((f) => f.kind === "overflow")?.text).toMatch(id === "narrow" ? /^At 390 px.*div\.strip/ : /div\.strip/);
    if (planted.expect === "clipped") expect(report.findings.find((f) => f.kind === "clipped")?.text).toMatch(/cut off by div\.tile/);
    if (planted.expect === "contrast") expect(report.findings.find((f) => f.kind === "contrast")?.text).toMatch(/p\.faint/);
    if (planted.expect === "bridge") expect(report.findings.find((f) => f.kind === "bridge")?.text).toMatch(/kos\.query: the query cannot run here/);
    if (planted.expect === "console") expect(report.findings.some((f) => /the chart had no data/.test(f.text))).toBe(true);
    if (planted.expect === "empty") expect(report.findings.find((f) => f.kind === "empty")?.text).toMatch(/div\.chart/);
    expect(reportWords(report)).toMatch(/one pass.*Do not check again/s);
  }, 45_000);
});

/** The dashboard's own build, when there is one: the runtimes and fonts as KOS serves them. */
const BUILT = resolve(here, "../../../ui/dist/page-lib");

/** One small artifact of each runtime kind, written the plain way the guide shows. */
const KINDS: Record<string, HtmlPage> = {
  doc: { id: "doc", kind: "doc", title: "Brief", html: `<article data-doc><header><p class="kicker">Brief</p><h1>Garden water plan</h1><p class="lede">Four rain tanks cover a third of summer watering.</p></header><h2>Why</h2><p>The tap at the gate cannot serve 42 plots<span class="fn">Plot count, October 2026.</span>.</p><table><tr><th>Item</th><th class="num">Cost</th></tr><tr><td>Tanks</td><td class="num">$4,800</td></tr></table></article>` },
  deck: { id: "deck", kind: "deck", title: "Pitch", html: `<main data-deck><section class="title"><h1>Westside garden, 2027</h1><p>General meeting, 19 November</p><aside class="notes">Open with the harvest.</aside></section><section><h2>Harvest rose a third</h2><p class="big">2,860 kg</p></section><section class="closing"><h2>Approve the water plan</h2></section></main>` },
  sheet: { id: "sheet", kind: "sheet", title: "Spend", html: `<h1>October spending</h1><script type="application/json" data-sheet>{"sheets":[{"name":"Expenses","freeze":1,"columns":[{"label":"Date","type":"date"},{"label":"Category"},{"label":"Amount","type":"currency","currency":"CAD"}],"rows":[["2026-10-01","Housing",1650],["2026-10-02","Food",56.37],["2026-10-04","Food",=SUM(C1:C1)]],"totals":{"Amount":"sum"}},{"name":"By category","columns":[{"label":"Category"},{"label":"Amount","type":"currency","currency":"CAD"}],"pivot":{"from":"Expenses","by":"Category","values":[{"column":"Amount","fn":"sum"}]}}]}</script>`.replace("=SUM(C1:C1)", '"=C2*2"') },
};

describe.skipIf(!chrome || !existsSync(join(BUILT, "kos-sheet.js")))("each runtime through artifacts.check", () => {
  let captures: string;
  let checker: ArtifactChecker;
  beforeAll(() => {
    captures = mkdtempSync(join(tmpdir(), "kos-captures-"));
    checker = new ArtifactChecker({ load: (id) => (KINDS[id] ? { page: KINDS[id]!, title: KINDS[id]!.title } : undefined), call: async () => ({ rows: [] }), captures: (id) => join(captures, id), pageLib: () => BUILT });
  });
  afterAll(() => {
    checker?.close();
    rmSync(captures, { recursive: true, force: true });
  });

  it.each(Object.keys(KINDS))("the %s runtime's own chrome passes, in both themes and widths", async (id) => {
    const report = await checker.check(id);
    expect(report.findings).toEqual([]);
  }, 45_000);
});
