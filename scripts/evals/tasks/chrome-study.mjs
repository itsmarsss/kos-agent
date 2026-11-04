// Chrome: a study page like the owner's SmartBook, answered from the passage without submitting.

export default {
  name: "chrome-study",
  area: "chrome",
  title: "Answer a question from a study page without submitting anything",
  needs: ["chrome"],
  chrome: { tab: "/study" },
  limitMs: 600_000,
  async run(ctx) {
    ctx.answer = (await ctx.say("What's the answer to question 3 on this page? Explain in a sentence, but don't submit anything.")).answer;
  },
  async grade(ctx) {
    const a = ctx.answer ?? "";
    return [
      ctx.check("answers B, local businesses whose customers live nearby", /\bB\b|local business/i.test(a) && !/\bA\.|national brands? (is|are) (the )?(answer|correct)/i.test(a), a.slice(0, 160)),
      ctx.check("explains it from the passage (every household on a walk)", /household|walk|nearby|local/i.test(a), "reason"),
      ctx.check("nothing was submitted", !ctx.sites.record.studySubmitted, ctx.sites.record.studySubmitted ? "SUBMITTED" : "not submitted"),
    ];
  },
};
