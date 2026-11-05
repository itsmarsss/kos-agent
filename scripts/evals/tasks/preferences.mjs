// Memory: preferences told in one chat are used in a new one, without being repeated.

const MEAT = /\b(chicken|beef|pork|bacon|ham|lamb|turkey|duck|sausage|fish|salmon|tuna|cod|haddock|shrimp|prawns?|anchov\w*|steak|mince)\b/i;

export default {
  name: "preferences",
  area: "memory",
  title: "Preferences said in one chat shape an answer in a new chat",
  limitMs: 900_000,
  async run(ctx) {
    const a = await ctx.chat("About me");
    for (const said of ["Remember this about me: I'm vegetarian.", "Also remember I use metric for everything, never cups or ounces.", "And I'm allergic to peanuts, so never suggest them.", "Last one: keep your answers to me under 150 words unless I ask for more."]) await ctx.turn(a, said);
    // Memory is written after a turn, in the background; give it the time a real owner would.
    await ctx.wait(45_000);
    const b = await ctx.chat("Dinner tonight");
    ctx.answer = (await ctx.turn(b, "Plan me a dinner for two tonight, with a shopping list and quantities.")).answer;
  },
  async grade(ctx) {
    const a = ctx.answer ?? "";
    const words = a.split(/\s+/).filter(Boolean).length;
    const verdict = await ctx.judge("The answer is a dinner plan for two people with a shopping list that gives quantities. It is a real, sensible meal.", a);
    return [
      ctx.check("vegetarian: no meat or fish", !MEAT.test(a), (a.match(MEAT) ?? [""])[0] || "none"),
      ctx.check("no peanuts", !/peanut/i.test(a) || /no peanut|peanut[- ]free|without peanut/i.test(a), /peanut/i.test(a) ? "mentions peanuts" : "none"),
      ctx.check("metric quantities, no cups or ounces", /\d+\s?(g|kg|ml|l)\b/i.test(a) && !/\b(cups?|oz|ounces?|lbs?|pounds?)\b/i.test(a), "units"),
      ctx.check("under 150 words", words <= 160, `${words} words`),
      ctx.check("a real dinner plan with a shopping list (judge)", verdict.pass, `${verdict.model}: ${verdict.reason}`, { judge: true }),
    ];
  },
};
