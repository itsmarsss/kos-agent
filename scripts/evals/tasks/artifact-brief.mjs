// Artifacts: a one-page project brief as a designed doc, from facts given in the chat.

import { gradeArtifact } from "../lib/artifacts.mjs";

const FACTS = `Facts:
- Riverside Family Clinic, 6 doctors, 2 front-desk staff. Bookings are by phone only today.
- The front desk takes about 140 calls a day; 60% are bookings or changes. Calls peak 8:30 to 10:00.
- No-show rate is 11%. Reminder calls are made by hand when there is time.
- Plan: online booking with SMS reminders, on the clinic's existing EMR (Accuro), using its booking module.
- Budget: $18,000 setup plus $450 a month. Target go-live 2 March 2027.
- Goal: cut booking calls by half and no-shows to 6% within three months of launch.
- Risks: older patients who will not book online (phone stays open), EMR module limits on appointment types, staff training time in February.
- Owner: Dana Okafor, clinic manager. Decision needed from the partners by 15 December.`;

export default {
  name: "artifact-brief",
  area: "artifacts",
  title: "A one-page project brief, written as a designed doc",
  limitMs: 900_000,
  async run(ctx) {
    const chat = await ctx.chat("Booking brief");
    await ctx.turn(chat, `Write a one-page project brief doc for rebuilding the Riverside clinic's booking system, for the partners to decide on.\n\n${FACTS}`);
  },
  async grade(ctx) {
    const { out, html } = await gradeArtifact(ctx, { kind: "doc" });
    if (html === undefined) return out;
    const article = /<article\b[^>]*data-doc[^>]*>([\s\S]*)<\/article>/i.exec(html)?.[1] ?? "";
    const words = article.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
    out.push(ctx.check("one page: 300 to 900 words, with a title and a lede", words >= 300 && words <= 900 && /<h1\b/i.test(article) && /class="[^"]*\blede\b/.test(article), `${words} words`));
    out.push(ctx.check("it carries the real facts: the cost, the date, the goal and the decision", ["18,000", "450", "2 March", "15 December"].every((f) => article.includes(f)) && /6\s?%/.test(article), ["18,000", "450", "2 March", "15 December", "6%"].filter((f) => !article.includes(f)).join(", ") || "all there"));
    return out;
  },
};
