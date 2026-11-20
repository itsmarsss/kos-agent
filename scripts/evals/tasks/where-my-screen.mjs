// Where to act: "my screen" is the owner's computer, a web page on it included.

import { dashboardTurns, onlyIn } from "../lib/where.mjs";

export default {
  name: "where-my-screen",
  area: "where",
  title: "Put a page up on the owner's screen when they say my screen",
  needs: ["mac", "chrome"],
  chrome: { tab: "/reviews" },
  limitMs: 360_000,
  async run(ctx) {
    const [t] = await dashboardTurns(ctx, "Waterfront", [`put ${ctx.sites.url}/longread up on my screen`]);
    ctx.answer = t.answer;
    ctx.since = t.t0;
  },
  grade: (ctx) => onlyIn(ctx, "mac", ctx.since),
};
