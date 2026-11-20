// Where to act: a message that only names a place carries the last request there, as the owner
// asked for a song and then said to do it with KOS on their Mac.

import { dashboardTurns, onlyIn } from "../lib/where.mjs";

export default {
  name: "where-mac-followup",
  area: "where",
  title: "Do the last request on the Mac when a message only names the Mac",
  needs: ["mac", "chrome"],
  chrome: { tab: "/reviews" },
  limitMs: 600_000,
  async run(ctx) {
    const [, second] = await dashboardTurns(ctx, "Prank", ["rick roll me", "using kos in mac"]);
    ctx.answer = second.answer;
    ctx.since = second.t0;
  },
  grade: (ctx) => [
    ...onlyIn(ctx, "mac", ctx.since),
    ctx.check("did not ask what to do on it", !/what (do you want|should i do)|what.*on it\?/i.test(ctx.answer ?? ""), (ctx.answer ?? "").slice(0, 160)),
  ],
};
