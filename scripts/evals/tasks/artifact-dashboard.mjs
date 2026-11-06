// Artifacts: a dashboard page over a project's own table, live through window.kos, that reads well
// in both themes and on a phone.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { gradeArtifact } from "../lib/artifacts.mjs";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/expenses-oct.csv");

/** October from the fixture, and a September a little lighter, the same every run. */
function rows() {
  const oct = readFileSync(FIXTURE, "utf8").trim().split("\n").slice(1).map((l) => l.split(","));
  const sep = oct.map(([d, c, i, a], n) => [d.replace("2026-10", "2026-09").replace(/-31$/, "-30"), c, i, (Number(a) * (0.8 + (n % 5) * 0.06)).toFixed(2)]);
  return [...sep, ...oct];
}

export default {
  name: "artifact-dashboard",
  area: "artifacts",
  title: "A budget dashboard page over the project's table, in both themes and on a phone",
  limitMs: 900_000,
  async setup(ctx) {
    ctx.slug = await ctx.project("Household budget");
    const values = rows().map(([d, c, i, a]) => `('${d}', '${c}', '${i.replace(/'/g, "''")}', ${a})`).join(",");
    ctx.sql(`create table ${ctx.slug}_tx (id integer primary key, date text not null, category text not null, merchant text, amount real not null);
      insert into ${ctx.slug}_tx (date, category, merchant, amount) values ${values};`);
  },
  async run(ctx) {
    const chat = await ctx.chat("Budget dashboard", ctx.slug);
    await ctx.turn(chat, "Make a budget dashboard page for this project: what I spent in October by category, the biggest expenses, and how October compares with September.");
  },
  async grade(ctx) {
    const { out, html } = await gradeArtifact(ctx, { kind: "page", project: ctx.slug });
    if (html === undefined) return out;
    out.push(ctx.check("it reads the project's table live, not pasted numbers", html.includes(`${ctx.slug}_tx`) && /kos\.query/.test(html) && !["56.37", "1650.00"].some((n) => html.includes(n)), html.includes(`${ctx.slug}_tx`) ? "queries the table" : "does not name the table"));
    return out;
  },
};
