// Where to act: a page the owner wants opened on their Mac goes to the Mac, not KOS's own browser.

import { dashboardTurns, onlyIn } from "../lib/where.mjs";

export default {
  name: "where-mac-page",
  area: "where",
  title: "Open a page on the owner's Mac when they say my Mac",
  needs: ["mac", "chrome"],
  chrome: { tab: "/reviews" },
  limitMs: 360_000,
  async run(ctx) {
    const [t] = await dashboardTurns(ctx, "Waterfront", [`open ${ctx.sites.url}/longread on my mac`]);
    ctx.answer = t.answer;
    ctx.since = t.t0;
  },
  grade: (ctx) => onlyIn(ctx, "mac", ctx.since),
};
