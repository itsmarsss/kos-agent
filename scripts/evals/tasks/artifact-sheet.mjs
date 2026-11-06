// Artifacts: pasted expenses as a sheet, with totals by category that stay right.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { gradeArtifact } from "../lib/artifacts.mjs";

const CSV = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../fixtures/expenses-oct.csv"), "utf8").trim();
const ROWS = CSV.split("\n").slice(1).map((l) => l.split(","));
const TOTAL = Math.round(ROWS.reduce((s, r) => s + Number(r[3]), 0) * 100) / 100;

export default {
  name: "artifact-sheet",
  area: "artifacts",
  title: "A sheet of pasted expenses with totals by category",
  limitMs: 900_000,
  async run(ctx) {
    const chat = await ctx.chat("Expenses sheet");
    await ctx.turn(chat, `Make a sheet of these expenses with totals by category.\n\n${CSV}`);
  },
  async grade(ctx) {
    const { out, html } = await gradeArtifact(ctx, { kind: "sheet" });
    if (html === undefined) return out;
    let book;
    try {
      book = JSON.parse(/<script\b[^>]*data-sheet[^>]*>([\s\S]*?)<\/script>/i.exec(html)?.[1] ?? "");
    } catch {
      book = undefined;
    }
    const tabs = book?.sheets ?? [];
    const data = tabs.find((t) => Array.isArray(t.rows) && t.rows.length >= ROWS.length);
    const sums = data ? data.columns.map((_, i) => Math.round(data.rows.reduce((s, r) => s + (typeof r[i] === "number" ? r[i] : 0), 0) * 100) / 100) : [];
    out.push(ctx.check(`every expense is in the sheet and adds up to ${TOTAL}`, !!data && data.rows.length === ROWS.length && sums.some((s) => Math.abs(s - TOTAL) < 0.011), data ? `${data.rows.length} rows; column sums ${sums.filter(Boolean).join(", ")}` : "no tab with the rows"));
    const amount = data ? data.columns.findIndex((c, i) => Math.abs(sums[i] - TOTAL) < 0.011) : -1;
    out.push(ctx.check("the amount column is typed as money", amount >= 0 && ["currency", "number"].includes(data.columns[amount].type), amount >= 0 ? String(data.columns[amount].type) : "-"));
    const byCategory = tabs.some((t) => t.pivot && /categ|^b$/i.test(String(t.pivot.by)) && t.pivot.values?.some((v) => v.fn === "sum")) || /SUMIF\(/i.test(JSON.stringify(book ?? {}));
    out.push(ctx.check("totals by category are computed (a pivot or SUMIF), not typed", byCategory, tabs.map((t) => `${t.name}${t.pivot ? " (pivot)" : ""}`).join(", ")));
    out.push(ctx.check("a totals row", tabs.some((t) => t.totals && Object.keys(t.totals).length > 0), tabs.filter((t) => t.totals).map((t) => t.name).join(", ") || "none"));
    return out;
  },
};
