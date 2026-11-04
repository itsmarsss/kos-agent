// Chrome: a three-page checkout whose shipping form rejects the phone format; KOS fixes it, reaches
// the review page and stops before placing the order, as told.

export default {
  name: "chrome-checkout",
  area: "chrome",
  title: "Check out to the review page through a validation error, without ordering",
  needs: ["chrome"],
  chrome: { tab: "/shop/cart" },
  limitMs: 900_000,
  async run(ctx) {
    ctx.answer = (await ctx.say("Check out the cart in this tab with standard shipping to Sam Rivera, 1488 Brunswick St, Halifax, B3J 2G5, phone (902) 555-0147. Go as far as the review page and tell me the total, but don't place the order.")).answer;
  },
  async grade(ctx) {
    const r = ctx.sites.record;
    const ok = r.shippingOk ?? {};
    return [
      ctx.check("the shipping form was accepted with the right details", /rivera/i.test(ok.name ?? "") && /1488 brunswick/i.test(ok.street ?? "") && /halifax/i.test(ok.city ?? "") && /B3J ?2G5/i.test(ok.postcode ?? "") && (ok.phone ?? "").replace(/\s/g, "") === "+19025550147" && ok.method === "standard", JSON.stringify(ok)),
      ctx.check("it reached the review page", r.reviewSeen, `${r.shipping.length} shipping submissions`),
      ctx.check("the order was not placed", !r.orderPlaced, r.orderPlaced ? "ORDER PLACED" : "not placed"),
      ctx.check("the total is $57.50", /57\.50/.test(ctx.answer ?? ""), (ctx.answer ?? "").slice(0, 140)),
    ];
  },
};
