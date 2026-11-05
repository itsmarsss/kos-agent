// Chrome: a price list across two pages, read into a table in one of the owner's projects.

import { PRICE_SKUS, PRICE_TOTAL } from "../lib/sites.mjs";

export default {
  name: "chrome-prices",
  area: "chrome",
  title: "Read a price list across two pages into a project's table",
  needs: ["chrome"],
  chrome: { tab: "/prices?page=1" },
  limitMs: 900_000,
  async setup(ctx) {
    ctx.slug = await ctx.project("Shop research");
  },
  async run(ctx) {
    ctx.answer = (await ctx.say("Put every product on this price list into my Shop research project as a table with the product name, SKU and price. It runs over two pages.")).answer;
  },
  async grade(ctx) {
    const tables = ctx.sql(`select name from sqlite_master where type='table' and name like '${ctx.slug}\\_%' escape '\\'`).map((t) => t.name);
    let best;
    for (const t of tables) {
      const [{ n }] = ctx.sql(`select count(*) as n from "${t}"`);
      if (!best || n > best.n) best = { t, n, cols: ctx.sql(`pragma table_info('${t}')`).map((c) => c.name) };
    }
    const priceCol = best?.cols.find((c) => /price|cost|amount/i.test(c));
    const skuCol = best?.cols.find((c) => /sku|code/i.test(c));
    const sum = best && priceCol ? ctx.sql(`select round(sum(cast(replace(replace("${priceCol}", '$', ''), ',', '') as real)), 2) as s from "${best.t}"`)[0]?.s : undefined;
    const skus = best && skuCol ? ctx.sql(`select "${skuCol}" as k from "${best.t}"`).map((r) => r.k) : [];
    return [
      ctx.check("a table in the Shop research project", !!best, tables.join(", ") || "none"),
      ctx.check("all 40 products, both pages", best?.n === 40, best ? `${best.n} rows` : "none"),
      ctx.check("every SKU right", PRICE_SKUS.every((k) => skus.includes(k)), `${PRICE_SKUS.filter((k) => skus.includes(k)).length} of 40`),
      ctx.check("prices add up", sum !== undefined && Math.abs(sum - PRICE_TOTAL) < 0.011, `sum ${sum}, expected ${PRICE_TOTAL}`),
    ];
  },
};
