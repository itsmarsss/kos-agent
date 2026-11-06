// Artifacts: six slides summarising meeting notes, as a deck.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { gradeArtifact } from "../lib/artifacts.mjs";

const NOTES = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../fixtures/garden-notes.md"), "utf8");

export default {
  name: "artifact-deck",
  area: "artifacts",
  title: "A six-slide deck that summarises a meeting's notes",
  limitMs: 900_000,
  async run(ctx) {
    const chat = await ctx.chat("Garden deck");
    await ctx.turn(chat, `Make a 6-slide deck summarizing these notes for the November general meeting.\n\n${NOTES}`);
  },
  async grade(ctx) {
    const { out, html } = await gradeArtifact(ctx, { kind: "deck" });
    if (html === undefined) return out;
    const deck = /<main\b[^>]*data-deck[^>]*>([\s\S]*)<\/main>/i.exec(html)?.[1] ?? "";
    const slides = (deck.match(/<section\b/gi) ?? []).length;
    out.push(ctx.check("six slides", slides === 6, `${slides} slides`));
    out.push(ctx.check("it carries the numbers and the decisions", /2,?860/.test(deck) && /7,?400/.test(deck) && /19 Nov/i.test(deck), ["2,860", "7,400", "19 Nov"].filter((f) => !new RegExp(f.replace(",", ",?"), "i").test(deck)).join(", ") || "all there"));
    out.push(ctx.check("presenter notes on some slides", /<aside\b[^>]*class="[^"]*\bnotes\b/i.test(deck), (deck.match(/class="[^"]*\bnotes\b/gi) ?? []).length + " notes"));
    return out;
  },
};
