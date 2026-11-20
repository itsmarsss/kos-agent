// Where to act: "my browser" is the owner's own Chrome.

import { dashboardTurns, onlyIn } from "../lib/where.mjs";

export default {
  name: "where-my-browser",
  area: "where",
  title: "Open a page in the owner's Chrome when they say my browser",
  needs: ["mac", "chrome"],
  chrome: { tab: "/reviews" },
  limitMs: 360_000,
  async run(ctx) {
    const [t] = await dashboardTurns(ctx, "Waterfront", [`pull up ${ctx.sites.url}/longread in my browser`]);
    ctx.answer = t.answer;
    ctx.since = t.t0;
  },
  grade: (ctx) => onlyIn(ctx, "chrome", ctx.since),
};
