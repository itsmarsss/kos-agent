// Where to act: "KOS in Chrome" is the owner's own Chrome, through the extension, not KOS's browser.

import { dashboardTurns, onlyIn } from "../lib/where.mjs";

export default {
  name: "where-chrome",
  area: "where",
  title: "Read a page in the owner's Chrome when they say KOS in Chrome",
  needs: ["mac", "chrome"],
  chrome: { tab: "/reviews" },
  limitMs: 360_000,
  async run(ctx) {
    const [t] = await dashboardTurns(ctx, "Waterfront", [`use kos in chrome and tell me what the first stop is on ${ctx.sites.url}/longread`]);
    ctx.answer = t.answer;
    ctx.since = t.t0;
  },
  grade: (ctx) => onlyIn(ctx, "chrome", ctx.since),
};
