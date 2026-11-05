// Long documents: two long PDFs and a long web page read early, eight unrelated turns, then
// details only the first PDF holds and one that needs both. What stubs and recall are for.

import { DOCS } from "../lib/sites.mjs";

const SMALL_TALK = [
  "Give me a name for a grey cat.",
  "What's 17 times 23?",
  "Rewrite 'see you soon' so it sounds more formal.",
  "What's a good houseplant for a dark room?",
  "Translate 'thank you very much' into Portuguese.",
  "Name three uses for baking soda.",
  "What time zone is Lisbon in?",
  "Suggest a title for a blog post about winter cycling.",
];

export default {
  name: "docs-recall",
  area: "context",
  title: "Two long PDFs and a web page, eight turns of other talk, then details from them",
  limitMs: 1_800_000,
  async setup(ctx) {
    await ctx.pdf(DOCS.ops.file, "/doc/ops");
    await ctx.pdf(DOCS.msa.file, "/doc/msa");
  },
  async run(ctx) {
    const chat = await ctx.chat("Reading pile");
    await ctx.turn(chat, `Read ${DOCS.ops.file} in the workspace and give me a one-line summary.`);
    await ctx.turn(chat, `Now read ${DOCS.msa.file} and give me a one-line summary of it too.`);
    await ctx.turn(chat, `And read this page, one line: ${ctx.sites.url}/longread`);
    for (const q of SMALL_TALK) await ctx.turn(chat, q);
    ctx.answers = [];
    for (const q of [
      "Back to the operations review: how many staff did the Lisbon office open with, and what does it handle?",
      "What is the fleet replacement budget, and when was it approved?",
      "When do night shifts end from January?",
      "Which company supplies our warehouses, and how much notice would we have to give to end our agreement with them?",
    ])
      ctx.answers.push((await ctx.turn(chat, q)).answer);
  },
  async grade(ctx) {
    const [a, b, c, d] = ctx.answers ?? [];
    const peak = Math.max(0, ...ctx.calls.map((x) => x.input + x.cached + x.written));
    return [
      ctx.check("Lisbon: 42 staff, EU support", /42/.test(a ?? "") && /EU|Europe/i.test(a ?? ""), (a ?? "").slice(0, 140)),
      ctx.check("fleet budget: CAD 2.35 million, 12 August", /2\.35/.test(b ?? "") && /12 Aug|August 12|Aug(ust)? 12|12th/i.test(b ?? ""), (b ?? "").slice(0, 140)),
      ctx.check("night shifts end at 05:30", /5:30|05:30|5\.30/.test(c ?? ""), (c ?? "").slice(0, 140)),
      ctx.check("across both: Northwind, 90 days' notice", /90/.test(d ?? "") && /Northwind/i.test(d ?? ""), (d ?? "").slice(0, 160)),
      ctx.check("the prompt stayed under 80k tokens late in the chat", peak > 0 && peak < 80_000, `peak ${peak}`, { required: false }),
    ];
  },
};
