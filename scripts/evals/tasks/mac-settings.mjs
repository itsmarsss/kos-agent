// Computer use: a setting two levels down (a pane, then a sheet), changed, and applied through a
// confirmation, without touching the settings beside it.

export default {
  name: "mac-settings",
  area: "computer",
  title: "Turn off usage analytics, two levels deep in Settings, and apply it",
  needs: ["mac"],
  mac: { setup: { apps: ["Settings"], front: "Settings" } },
  limitMs: 900_000,
  async run(ctx) {
    const chat = await ctx.chat("Analytics off");
    ctx.answer = (await ctx.turn(chat, "On Eval Mac, turn off usage analytics sharing in Settings and make sure the change is actually applied. Don't change anything else. End the session when done.")).answer;
  },
  async grade(ctx) {
    const s = await ctx.mac.state();
    const a = s.settings.applied;
    return [
      ctx.check("usage analytics is off and applied", a.analytics === false, JSON.stringify(a)),
      ctx.check("nothing else was changed", a.location === true && a.crash === true && a.ads === true, JSON.stringify(a)),
      ctx.check("no change left unapplied", Object.keys(s.settings.draft).length === 0, JSON.stringify(s.settings.draft)),
    ];
  },
};
