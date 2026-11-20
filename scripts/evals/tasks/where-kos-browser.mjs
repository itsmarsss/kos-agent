// Where to act: "KOS's browser" is KOS's own headless Chrome, even with the owner's Mac and Chrome paired.

import { dashboardTurns, onlyIn } from "../lib/where.mjs";

export default {
  name: "where-kos-browser",
  area: "where",
  title: "Read a page in KOS's own browser when they say KOS's browser",
  needs: ["mac", "chrome"],
  chrome: { tab: "/reviews" },
  limitMs: 360_000,
  async run(ctx) {
    const [t] = await dashboardTurns(ctx, "Waterfront", [`in kos's browser, open ${ctx.sites.url}/longread and tell me the first stop`]);
    ctx.answer = t.answer;
    ctx.since = t.t0;
  },
  grade: (ctx) => onlyIn(ctx, "kos", ctx.since),
};
