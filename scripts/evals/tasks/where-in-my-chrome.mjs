// Where to act: "in my chrome" is the owner's own Chrome, even for a question KOS's browser could answer.

import { dashboardTurns, onlyIn } from "../lib/where.mjs";

export default {
  name: "where-in-my-chrome",
  area: "where",
  title: "Answer from a page in the owner's Chrome when they say in my chrome",
  needs: ["mac", "chrome"],
  chrome: { tab: "/reviews" },
  limitMs: 360_000,
  async run(ctx) {
    const [t] = await dashboardTurns(ctx, "Waterfront", [`whats the first stop on ${ctx.sites.url}/longread, check in my chrome`]);
    ctx.answer = t.answer;
    ctx.since = t.t0;
  },
  grade: (ctx) => onlyIn(ctx, "chrome", ctx.since),
};
