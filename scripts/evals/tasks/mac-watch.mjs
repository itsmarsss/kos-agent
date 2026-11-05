// Computer use: a test run that takes about 90 seconds; KOS watches until it ends and reports the
// result line, without being told when.

export default {
  name: "mac-watch",
  area: "computer",
  title: "Watch a 90 second test run in Terminal and report its result",
  needs: ["mac"],
  mac: { setup: { apps: ["Terminal"], front: "Terminal" }, query: "termSecs=90" },
  limitMs: 900_000,
  async run(ctx) {
    const chat = await ctx.chat("Watch the tests");
    ctx.answer = (await ctx.turn(chat, "On Eval Mac, a test run is going in Terminal. Watch it until it finishes, then tell me the result line and which tests failed. End the session after.")).answer;
  },
  async grade(ctx) {
    const a = ctx.answer ?? "";
    return [
      ctx.check("the result: 3 failed, 412 passed", /3 failed/i.test(a) && /412 passed/i.test(a), a.slice(0, 160)),
      ctx.check("names the failing tests", ["billing", "sync", "export"].filter((t) => new RegExp(t, "i").test(a)).length >= 2, "billing, sync, export"),
      ctx.check("it watched in at most 12 looks", ctx.tools.filter((t) => t.tool === "computer.act").length <= 12, `${ctx.tools.filter((t) => t.tool === "computer.act").length} computer.act calls`, { required: false }),
    ];
  },
};
