import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findChrome } from "@kos/browser";
import { COLOURS, type HtmlPage } from "@kos/shared";

import Database from "better-sqlite3";

import { ArtifactChecker, reportWords, type Finding } from "./artifactcheck.js";
import { PageQueries } from "./pagequeries.js";

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

/** A page written to the guide: KOS's tokens, sections set apart by rules, nothing literal, nothing empty. */
const GOOD = `<style>
/* layout: one column, the log over its table */
main{max-width:640px;display:flex;flex-direction:column;gap:12px}
p{color:var(--muted)} section{border-top:1px solid var(--line);padding-top:12px} .entry{border:1px solid var(--line);border-radius:var(--r-md);padding:12px;background:var(--panel)}
</style><main><h1>Garden log</h1><a id="jump" href="#days">Jump to the days</a><p>Watering, week of 3 November.</p><div class="entry">Tomatoes: 2 L on Monday</div><section><table id="days"><tr><th>Day</th><th>Litres</th></tr><tr><td>Mon</td><td>2</td></tr></table></section></main>
<script>jump.click();kos.query("SELECT 1 AS n").then(function(r){document.querySelector("p").textContent += " " + r.rows.length + " row."})</script>`;

/** A distinctive piece with its own token plan, for both themes: its own ground is its to choose. */
const POSTER = `<style>
:root{--paper:#fbfaf7;--ink:#1d2330;--quiet:#5a6275;--mark:#2f5bd3}
@media (prefers-color-scheme: dark){:root:not([data-theme=light]){--paper:#11141b;--ink:#e6e9f0;--quiet:#9aa3b5;--mark:#86a4ff}}
:root[data-theme=dark]{--paper:#11141b;--ink:#e6e9f0;--quiet:#9aa3b5;--mark:#86a4ff}
body{background:var(--paper);color:var(--ink)} p{color:var(--quiet)}
</style><h1>Harvest supper</h1><p>Saturday 21 November, at the pavilion.</p><section style="background:var(--ink);color:var(--paper);height:240px;padding:24px"><p style="color:var(--paper)">Bring a dish</p></section>`;

/** A section wrapped in a bordered box, as a generated dashboard draws each one. */
const boxed = (title: string): string => `<div style="border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:12px"><h2>${title}</h2><table><tr><td>Mon</td><td>2</td></tr></table></div>`;

/** Big figures in a row, each with its label. */
const figures = (...values: string[]): string => `<div class="grid">${values.map((v, i) => `<div><span style="font-size:28px;font-weight:600">${v}</span> <span>figure ${i + 1}</span></div>`).join("")}</div>`;

/** A card for one object: a book, its author, its state. */
const book = (title: string): string => `<div style="border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:8px"><h3>${title}</h3><p>Albert Camus, 1942</p><span class="pill">reading</span></div>`;

/** A board's lane: a heading and its cards, side by side with the other lanes. */
const lane = (name: string): string => `<div class="lane" style="border:1px solid var(--line);border-radius:10px;padding:12px;flex:1 1 220px;min-width:0"><h2>${name}</h2><ul style="list-style:none;padding:0">${book("The Stranger")}${book("The Plague")}</ul></div>`;

/** A closed fold of a few lines, as the doc runtime's contents are on a phone. */
const FOLD = `<details><summary>Contents</summary><ol><li>Why</li><li>What</li><li>Cost</li><li>When</li></ol></details>`;

const PLANTED: Record<string, { html: string; expect: Finding["kind"] }> = {
  wide: { html: `<h1>Wide</h1><div class="strip" style="width:1800px;height:40px;background:var(--panel)">a strip</div>`, expect: "overflow" },
  // Too wide only for a phone: caught only if the phone render is laid out at the phone's width.
  narrow: { html: `<h1>Narrow</h1><div class="strip" style="width:600px;height:40px;background:var(--panel)">a strip</div>`, expect: "overflow" },
  // Tiles too narrow for their words, which a hidden overflow cuts off: the page does not scroll, it just loses text.
  cramped: { html: `<h1>Cramped</h1><div style="display:flex;gap:8px"><div class="tile" style="width:40px;overflow:hidden;white-space:nowrap;border:1px solid var(--line)">Total spent this month</div></div>`, expect: "clipped" },
  // Rows scrolled out of a box are not drawn over what follows it: no overlap there.
  scrolled: { html: `<h1>Scrolled</h1><div style="max-height:60px;overflow:auto"><p>one</p><p>two</p><p>three</p><p>four</p><p>five</p></div><p>After the box</p><p>And more after it</p>`, expect: "none" as never },
  // What a closed fold holds is laid out over what follows it, but it is not drawn: no overlap.
  folded: { html: `${FOLD}<h1>Folded</h1><p>What follows the fold.</p>`, expect: "none" as never },
  // The same, where the frame has no checkVisibility to ask.
  "folded without checkVisibility": { html: `<script>delete Element.prototype.checkVisibility</script>${FOLD}<h1>Folded</h1><p>What follows the fold.</p>`, expect: "none" as never },
  stacked: { html: `<h1>Stacked</h1><div style="position:relative;height:60px"><p class="label" style="position:absolute;top:0;left:0;margin:0">Total spent</p><p class="value" style="position:absolute;top:4px;left:10px;margin:0">$3,340.87</p></div>`, expect: "overlap" },
  literal: { html: `<style>body{background:#ffffff;color:#222222}</style><h1>Literal</h1><p>One</p><p>Two</p><p>Three</p><p>Four</p><p>Five</p><p>Six</p>`, expect: "theme" },
  faint: { html: `<h1>Faint</h1><p class="faint" style="color:#8a8a8a;background:#9a9a9a">hard to read</p>`, expect: "contrast" },
  noisy: { html: `<h1>Noisy</h1><script>console.error("the chart had no data"); null.x;</script>`, expect: "console" },
  refused: { html: `<h1>Refused</h1><div id="out">waiting</div><script>kos.query("SELECT * FROM nowhere").then(function(){}, function(e){out.textContent = "none"})</script>`, expect: "bridge" },
  hollow: { html: `<h1>Hollow</h1><div class="chart" style="width:320px;height:180px;border:1px solid var(--line)"></div>`, expect: "empty" },
  untitled: { html: `<p>Just a line of text, no heading.</p>`, expect: "title" },
  formula: { html: `<h1>Sheet</h1><table><tr><td>#REF!</td></tr></table>`, expect: "formula" },
  leaving: { html: `<h1>Leaving</h1><script>setTimeout(function(){ var a = document.createElement("a"); a.href = "https://example.com/x"; document.body.append(a); a.click(); }, 50)</script>`, expect: "left" },
  // A title band in the ink colour: dark on a light page, light on a dark one.
  inverted: { html: `<h1>Inverted</h1><section style="background:var(--text);color:var(--bg);height:320px;padding:24px"><p>Season review</p></section>`, expect: "inverted" },
  boxes: { html: `<h1>Boxes</h1>${boxed("Open now")}${boxed("Needs a nudge")}${boxed("Recent")}`, expect: "boxes" },
  zeros: { html: `<h1>Zeros</h1>${figures("0", "0", "$0.00")}`, expect: "figures" },
  // The kit's own stat tiles, as a generated dashboard writes them.
  "kit zeros": { html: `<h1>Kit zeros</h1><div class="grid"><div class="stat"><span class="stat-value">0</span><span class="stat-label">Figure 1</span></div><div class="stat"><span class="stat-value">0</span><span class="stat-label">Figure 2</span></div><div class="stat"><span class="stat-value">$0.00</span><span class="stat-label">Figure 3</span></div></div>`, expect: "figures" },
  "kit dashes": { html: `<h1>Kit dashes</h1><div class="grid"><div class="stat"><span class="stat-value">—</span><span class="stat-label">Figure 1</span></div><div class="stat"><span class="stat-value">—</span><span class="stat-label">Figure 2</span></div><div class="stat"><span class="stat-value">—</span><span class="stat-label">Figure 3</span></div></div>`, expect: "figures" },
  placeholder: { html: `<h1>Placeholder</h1>${figures("12", "—")}`, expect: "figures" },
  // One zero among real figures is news ("0 overdue"), not noise; a status dot is an empty leaf, not a figure.
  "one zero": { html: `<h1>One zero</h1>${figures("12", "0", "3")}<p><span class="dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--ok);font-size:28px"></span> on track</p>`, expect: "none" as never },
  // Cards for objects, and a board's lanes side by side: not sections in boxes.
  cards: { html: `<h1>Cards</h1>${book("The Stranger")}${book("The Plague")}${book("The Fall")}<div style="display:flex;gap:12px">${lane("Reading")}${lane("Queued")}</div>`, expect: "none" as never },
  // A board of three lanes, each its heading over cards of its own: one set, not three sections in boxes.
  board: { html: `<h1>Board</h1><div style="display:flex;flex-wrap:wrap;gap:12px">${lane("Queued")}${lane("Reading")}${lane("Finished")}</div>`, expect: "none" as never },
  // A deck with a plan of its own whose title slide alone is inverted, the rest hidden as the runtime hides them.
  "odd slide": { html: `<style>:root{--paper:#fbfaf7;--ink:#1d2330}@media (prefers-color-scheme: dark){:root:not([data-theme=light]){--paper:#11141b;--ink:#e6e9f0}}:root[data-theme=dark]{--paper:#11141b;--ink:#e6e9f0}body{background:var(--paper);color:var(--ink)}</style><h1>Deck</h1><div class="deck-slide"><section style="background:var(--ink);color:var(--paper);height:300px;padding:24px"><h2 style="color:var(--paper)">Westside 2027</h2></section></div><div class="deck-slide" style="display:none"><section style="background:var(--paper);color:var(--ink);height:300px;padding:24px"><h2 style="color:var(--ink)">Harvest</h2></section></div><div class="deck-slide" style="display:none"><section style="background:var(--paper);color:var(--ink);height:300px;padding:24px"><h2 style="color:var(--ink)">Water</h2></section></div><div class="deck-slide" style="display:none"><section style="background:var(--paper);color:var(--ink);height:300px;padding:24px"><h2 style="color:var(--ink)">Ask</h2></section></div>`, expect: "inverted" },
  "even slides": { html: `<style>:root{--paper:#fbfaf7;--ink:#1d2330}@media (prefers-color-scheme: dark){:root:not([data-theme=light]){--paper:#11141b;--ink:#e6e9f0}}:root[data-theme=dark]{--paper:#11141b;--ink:#e6e9f0}body{background:var(--paper);color:var(--ink)}</style><h1>Deck</h1><div class="deck-slide"><section style="background:var(--paper);color:var(--ink);height:300px;padding:24px"><h2 style="color:var(--ink)">Westside 2027</h2></section></div><div class="deck-slide" style="display:none"><section style="background:var(--paper);color:var(--ink);height:300px;padding:24px"><h2 style="color:var(--ink)">Harvest</h2></section></div><div class="deck-slide" style="display:none"><section style="background:var(--paper);color:var(--ink);height:300px;padding:24px"><h2 style="color:var(--ink)">Water</h2></section></div>`, expect: "none" as never },
  // Object cards stacked: a bold title and a button, no section in them.
  "object cards": { html: `<h1>Tasks</h1>${["Water the beds", "Order tanks", "Book the hall"].map((t) => `<div style="border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:8px"><div style="font-weight:600">${t}</div><p>Due Friday</p><button class="btn">Open</button></div>`).join("")}`, expect: "none" as never },
  // Section cards side by side, each with its own heading and table: sections in boxes still.
  "side boxes": { html: `<h1>Side</h1><div style="display:flex;gap:12px">${["Open", "Due", "Done"].map((t) => `<div class="card" style="flex:1;border:1px solid var(--line);border-radius:10px;padding:12px"><h2>${t}</h2><table><tr><td>Mon</td><td>2</td></tr></table></div>`).join("")}</div>`, expect: "boxes" },
  // Fills that are inline spans given a width draw nothing; the kit's meter and block fills draw.
  bars: { html: `<h1>Bars</h1>${["Housing", "Groceries"].map((c) => `<p>${c}</p><div style="height:8px;background:var(--panel-2)"><span style="width:60%;background:var(--accent)"></span></div>`).join("")}`, expect: "bars" },
  "unset meter": { html: `<h1>Unset</h1><p>Housing</p><div class="meter"></div>`, expect: "bars" },
  // A month of real zeros: block fills at 0% are data, not a bug.
  "zero bars": { html: `<h1>Zero bars</h1>${["Housing", "Groceries", "Fun"].map((c) => `<p>${c}</p><div style="height:8px;width:300px;background:var(--panel-2)"><div style="width:0%;height:100%;background:var(--accent)"></div></div>`).join("")}`, expect: "none" as never },
  meters: { html: `<h1>Meters</h1><p>Housing</p><div class="meter" style="--value: 60%"></div><p>Groceries</p><div class="meter"><div style="width:30%"></div></div><p>Fun</p><div class="meter"><div style="width:0%"></div></div>`, expect: "none" as never },
  ground: { html: `<style>body{background:var(--panel-2)}</style><h1>Ground</h1><p>A slab of its own.</p>`, expect: "ground" },
  // Colours a browser computes outside rgb(): read as they draw, not as white or black.
  "oklch ground": { html: `<style>body{background:oklch(0.62 0.12 40)}</style><h1>Oklch</h1><p>A slab of its own.</p>`, expect: "ground" },
  "mixed kos ground": { html: `<style>body{background:color-mix(in srgb, var(--bg) 100%, transparent)}</style><h1>Mixed</h1><p>KOS's ground, mixed.</p>`, expect: "none" as never },
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
    pages.poster = { id: "poster", title: "Harvest supper", html: POSTER };
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
    // After a patch, a clean check is its words alone.
    const quiet = await checker.tool("good", { patch: true });
    expect(quiet.images).toBeUndefined();
    expect(quiet.text).not.toMatch(/pictures/);
  }, 45_000);

  it("leaves a distinctive piece's own ground alone when it declares a token plan", async () => {
    const report = await checker.check("poster");
    expect(report.findings).toEqual([]);
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
    if (id === "oklch ground") expect(report.findings.find((f) => f.kind === "ground")?.text).not.toMatch(/rgb\((0, 0, 0|255, 255, 255)\)/);
    if (["inverted", "boxes", "figures", "ground", "bars"].includes(planted.expect)) {
      expect(report.findings.find((f) => f.kind === planted.expect)?.small).toBe(true);
      expect(reportWords(report)).toContain(`[${planted.expect}, small]`);
    }
    if (id === "placeholder") expect(report.findings.find((f) => f.kind === "figures")?.text).toMatch(/reads "—"/);
    expect(reportWords(report)).toMatch(/one pass.*Do not check again/s);
  }, 45_000);
});

/** The dashboard's own build, when there is one: the runtimes and fonts as KOS serves them. */
const BUILT = resolve(here, "../../../ui/dist/page-lib");

const CATEGORIES = ["Housing", "Groceries", "Dining", "Transport", "Utilities", "Fun", "Health", "Other"];

/** One small artifact of each runtime kind, written the plain way the guide shows. */
const KINDS: Record<string, HtmlPage> = {
  doc: { id: "doc", kind: "doc", title: "Brief", html: `<article data-doc><header><p class="kicker">Brief</p><h1>Garden water plan</h1><p class="lede">Four rain tanks cover a third of summer watering.</p></header><h2>Why</h2><p>The tap at the gate cannot serve 42 plots<span class="fn">Plot count, October 2026.</span>.</p><table><tr><th>Item</th><th class="num">Cost</th></tr><tr><td>Tanks</td><td class="num">$4,800</td></tr></table></article>` },
  // Four sections: the contents fold above the text on a phone, closed, and what a closed fold holds is not on screen.
  "long doc": { id: "long doc", kind: "doc", title: "Plan", html: `<article data-doc><header><p class="kicker">Plan</p><h1>Garden water plan</h1><p class="lede">Four rain tanks cover a third of summer watering.</p></header>${["Why", "What", "Cost", "When"].map((h) => `<h2>${h}</h2><p>The tap at the gate cannot serve 42 plots, so the tanks go by the sheds.</p>`).join("")}</article>` },
  deck: { id: "deck", kind: "deck", title: "Pitch", html: `<main data-deck><section class="title"><h1>Westside garden, 2027</h1><p>General meeting, 19 November</p><aside class="notes">Open with the harvest.</aside></section><section><h2>Harvest rose a third</h2><p class="big">2,860 kg</p></section><section class="closing"><h2>Approve the water plan</h2></section></main>` },
  sheet: { id: "sheet", kind: "sheet", title: "Spend", html: `<h1>October spending</h1><script type="application/json" data-sheet>{"sheets":[{"name":"Expenses","freeze":1,"columns":[{"label":"Date","type":"date"},{"label":"Category"},{"label":"Amount","type":"currency","currency":"CAD"}],"rows":[["2026-10-01","Housing",1650],["2026-10-02","Food",56.37],["2026-10-04","Food",=SUM(C1:C1)]],"totals":{"Amount":"sum"}},{"name":"By category","columns":[{"label":"Category"},{"label":"Amount","type":"currency","currency":"CAD"}],"pivot":{"from":"Expenses","by":"Category","values":[{"column":"Amount","fn":"sum"}]}}]}</script>`.replace("=SUM(C1:C1)", '"=C2*2"') },
  // Twelve columns, wider than a phone, in a flex row that sizes it by its content: the grid scrolls in its own box, never the page.
  "wide sheet": { id: "wide sheet", kind: "sheet", title: "Year", html: `<h1>The year by month</h1><div style="display:flex"><section><script type="application/json" data-sheet>${JSON.stringify({ sheets: [{ name: "Months", freeze: 1, columns: [{ label: "Line" }, ...Array.from({ length: 11 }, (_, i) => ({ label: `Month ${i + 1}`, type: "currency", currency: "CAD" }))], rows: Array.from({ length: 6 }, (_, r) => [`Line ${r + 1}`, ...Array.from({ length: 11 }, (_, c) => 1000 * (r + 1) + c)]), totals: { B: "sum" } }] })}</script></section></div>` },
  // The month by category under its grid, as the eval's budgets draw it: eight words under eight bars, too many side by side on a phone.
  "chart sheet": { id: "chart sheet", kind: "sheet", title: "Budget", html: `<h1>October by category</h1><script type="application/json" data-sheet>${JSON.stringify({ sheets: [{ name: "By category", columns: [{ label: "Category" }, { label: "Amount", type: "currency", currency: "CAD" }], rows: CATEGORIES.map((c, i) => [c, 1650 - i * 180]) }], charts: [{ type: "bar", title: "Spend by category", labels: "A1:A8", values: "B1:B8" }] })}</script>` },
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

/** Ten queries at once, as a dashboard's charts ask them, then whether all ten came back. */
const MANY = `<h1>Reading</h1><p id="out">waiting</p><script>Promise.all(Array.from({ length: 10 }, function (_, i) { return kos.query("SELECT n + ? AS n FROM books", [i]) })).then(function (all) { out.textContent = all.length + " answered" }, function (e) { out.textContent = "query failed: " + e.message })</script>`;

describe.skipIf(!chrome)("artifacts.check over real page queries", () => {
  let dir: string;
  let queries: PageQueries;
  let checker: ArtifactChecker;
  let lib: string;
  const pages: Record<string, HtmlPage> = {
    many: { id: "many", title: "Reading", html: MANY },
    broken: { id: "broken", title: "Broken", html: `<h1>Broken</h1><p id="out">waiting</p><script>kos.query("SELECT missing FROM books").then(function () {}, function (e) { out.textContent = "query failed" })</script>` },
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "kos-queries-"));
    const db = new Database(join(dir, "kos.sqlite"));
    db.exec("CREATE TABLE books (n INTEGER); INSERT INTO books VALUES (1), (2), (3);");
    db.close();
    queries = new PageQueries(join(dir, "kos.sqlite"));
    lib = pageLib();
    checker = new ArtifactChecker({
      load: (id) => (pages[id] ? { page: pages[id]!, title: pages[id]!.title } : undefined),
      call: (id, _verb, args) => queries.run(String(args.sql), (args.params as number[] | undefined) ?? [], { key: id }),
      captures: (id) => join(dir, "captures", id),
      pageLib: () => lib,
    });
  });

  afterAll(() => {
    checker?.close();
    queries?.close();
    rmSync(lib, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers ten queries asked at once, in every render, with nothing to report", async () => {
    const report = await checker.check("many");
    expect(report.findings).toEqual([]);
  }, 45_000);

  it("reports a query the page's own SQL breaks", async () => {
    const report = await checker.check("broken");
    expect(report.findings.find((f) => f.kind === "bridge")?.text).toMatch(/kos\.query: no such column: missing/);
  }, 45_000);
});

describe.skipIf(!chrome)("the check's Chrome, one job at a time", () => {
  it("stops a job that holds it past its ceiling, and starts the next on a fresh one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kos-ceiling-"));
    const checker = new ArtifactChecker({ load: () => undefined, call: async () => ({}), captures: (id) => join(dir, id), jobMs: 1500 });
    try {
      await expect(checker.withBrowser(() => new Promise<never>(() => undefined))).rejects.toThrow(/took too long/);
      expect(await checker.withBrowser(async ({ cdp }) => ((await cdp.send("Browser.getVersion", {})) as { product: string }).product)).toMatch(/Chrome/);
    } finally {
      checker.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
