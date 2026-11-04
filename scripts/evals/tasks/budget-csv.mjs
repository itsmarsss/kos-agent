// Projects: a messy bank export pasted into a chat becomes a budget project, with its rows,
// categories, a page of spend by category and a monthly reminder.

const MERCHANTS = [["Sobeys, Quinpool", "groceries"], ["Atlantic Superstore", "groceries"], ["Shell Robie St", "fuel"], ["Irving Oil", "fuel"], ["Halifax Transit", "transport"], ["Netflix", "subscriptions"], ["Spotify", "subscriptions"], ["Nova Scotia Power", "utilities"], ["Eastlink", "utilities"], ["The Old Apothecary", "dining"], ["Tim Hortons", "dining"], ["Steele Ford Service", "car"], ["Lawtons Drugs", "health"], ["Indigo Spring Garden", "shopping"]];
/** Sixty transactions, the same every run, and the export's mess around them. */
export function bankCsv() {
  const rows = [];
  for (let i = 0; i < 60; i++) {
    const [m] = MERCHANTS[(i * 5) % MERCHANTS.length];
    const day = String(1 + (i % 28)).padStart(2, "0");
    const month = i < 30 ? "09" : "10";
    let amount = Math.round((6 + ((i * 53) % 140) + (i % 3) * 0.37) * 100) / 100;
    if (i === 41) amount = 1234.5;
    if (i === 17) amount = -45;
    rows.push({ date: `2026-${month}-${day}`, description: m, amount });
  }
  const fmt = (r) => {
    const d = r.description.includes(",") ? `"${r.description}"` : r.description;
    const a = r.amount === 1234.5 ? `"1,234.50"` : r.amount.toFixed(2);
    return `${r.date},${d},${a}`;
  };
  const lines = ["Date,Description,Amount", ...rows.slice(0, 30).map(fmt), "", "Date,Description,Amount", ...rows.slice(30).map(fmt)];
  const total = Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100;
  return { csv: lines.join("\n"), total, count: rows.length };
}

export default {
  name: "budget-csv",
  area: "projects",
  title: "A pasted bank export becomes a budget project with a page and a monthly reminder",
  limitMs: 900_000,
  async run(ctx) {
    const { csv } = bankCsv();
    const chat = await ctx.chat("Budget from bank export");
    await ctx.turn(chat, `Here's my bank export for September and October. Make me a budget project from it: keep every transaction, give each one a category, make a page that shows my spend by category, and remind me on the 1st of every month to review it.\n\n${csv}`);
  },
  async grade(ctx) {
    const { total, count } = bankCsv();
    const made = ctx.sql(`select slug from manifest where type != 'system' and created_at >= ${ctx.t0}`);
    const slug = made[0]?.slug;
    const out = [ctx.check("a project was made", !!slug, slug ?? "none")];
    if (!slug) return out;
    const tables = ctx.sql(`select name from sqlite_master where type = 'table' and name like '${slug}\\_%' escape '\\'`).map((t) => t.name);
    let best;
    for (const t of tables) {
      const cols = ctx.sql(`pragma table_info('${t}')`).map((c) => c.name);
      const [{ n }] = ctx.sql(`select count(*) as n from "${t}"`);
      if (!best || n > best.n) best = { t, n, cols };
    }
    out.push(ctx.check("every transaction is in a table", best?.n === count, best ? `${best.t}: ${best.n} rows of ${count}` : "no table"));
    if (best) {
      const sums = best.cols.map((c) => ({ c, s: ctx.sql(`select round(sum(cast(replace("${c}", ',', '') as real)), 2) as s from "${best.t}"`)[0]?.s }));
      const hit = sums.find((x) => Math.abs((x.s ?? 0) - total) < 0.011 || Math.abs((x.s ?? 0) + total) < 0.011);
      out.push(ctx.check("the amounts add up, messy rows included", !!hit, hit ? `${hit.c} sums to ${hit.s}` : `expected ${total}; sums ${JSON.stringify(sums.filter((x) => x.s))}`));
      const catCol = best.cols.find((c) => /categ/i.test(c));
      const cats = catCol ? ctx.sql(`select count(distinct "${catCol}") as d, sum(case when "${catCol}" is null or "${catCol}" = '' then 1 else 0 end) as blank from "${best.t}"`)[0] : undefined;
      out.push(ctx.check("each transaction has a category", !!cats && cats.d >= 5 && cats.blank === 0, cats ? `${cats.d} categories, ${cats.blank} blank` : "no category column"));
    }
    const pages = ctx.sql(`select id, path from pages where project_slug = '${slug}'`);
    const spec = pages.map((p) => ctx.readFile(p.path) ?? "").join("\n");
    out.push(ctx.check("a page shows spend by category from the table", pages.length > 0 && tables.some((t) => spec.includes(t)) && /categ/i.test(spec), pages.length ? `${pages.length} page(s)` : "no page"));
    const crons = ctx.sql(`select schedule, type, enabled, project_slug from crons where created_at >= ${ctx.t0}`);
    const monthly = crons.find((c) => /^\S+\s+\S+\s+1\s+\*\s+\*$/.test(c.schedule.trim()) && c.enabled);
    out.push(ctx.check("a reminder runs on the 1st of each month", !!monthly, crons.map((c) => c.schedule).join("; ") || "no schedule"));
    return out;
  },
};
