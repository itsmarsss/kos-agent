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
p{color:var(--quiet)} .tile{border:1px solid var(--rule);padding:12px;color:var(--ink)}
</style><main><h1>Garden log</h1><p>Watering, week of 3 November.</p><div class="tile">Tomatoes: 2 L on Monday</div><table><tr><th>Day</th><th>Litres</th></tr><tr><td>Mon</td><td>2</td></tr></table></main>
<script>kos.query("SELECT 1 AS n").then(function(r){document.querySelector("p").textContent += " " + r.rows.length + " row."})</script>`;

const PLANTED: Record<string, { html: string; expect: Finding["kind"] }> = {
  wide: { html: `<h1>Wide</h1><div class="strip" style="width:1800px;height:40px;background:var(--panel)">a strip</div>`, expect: "overflow" },
  literal: { html: `<style>body{background:#ffffff;color:#222222}</style><h1>Literal</h1><p>One</p><p>Two</p><p>Three</p><p>Four</p><p>Five</p><p>Six</p>`, expect: "theme" },
  faint: { html: `<h1>Faint</h1><p class="faint" style="color:#8a8a8a;background:#9a9a9a">hard to read</p>`, expect: "contrast" },
  noisy: { html: `<h1>Noisy</h1><script>console.error("the chart had no data"); null.x;</script>`, expect: "console" },
  refused: { html: `<h1>Refused</h1><div id="out">waiting</div><script>kos.query("SELECT * FROM nowhere").then(function(){}, function(e){out.textContent = "none"})</script>`, expect: "bridge" },
  hollow: { html: `<h1>Hollow</h1><div class="chart" style="width:320px;height:180px;border:1px solid var(--line)"></div>`, expect: "empty" },
  untitled: { html: `<p>Just a line of text, no heading.</p>`, expect: "title" },
  formula: { html: `<h1>Sheet</h1><table><tr><td>#REF!</td></tr></table>`, expect: "formula" },
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

  it("finds nothing wrong with a page written to the guide, and keeps its four captures", async () => {
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
    expect(kinds).toContain(planted.expect);
    if (planted.expect === "overflow") expect(report.findings.find((f) => f.kind === "overflow")?.text).toMatch(/div\.strip/);
    if (planted.expect === "contrast") expect(report.findings.find((f) => f.kind === "contrast")?.text).toMatch(/p\.faint/);
    if (planted.expect === "bridge") expect(report.findings.find((f) => f.kind === "bridge")?.text).toMatch(/kos\.query: the query cannot run here/);
    if (planted.expect === "console") expect(report.findings.some((f) => /the chart had no data/.test(f.text))).toBe(true);
    if (planted.expect === "empty") expect(report.findings.find((f) => f.kind === "empty")?.text).toMatch(/div\.chart/);
    expect(reportWords(report)).toMatch(/one pass.*Do not check again/s);
  }, 45_000);
});
