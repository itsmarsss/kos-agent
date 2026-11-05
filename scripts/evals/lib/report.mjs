// Turning runs into a report: per task, how often it fully succeeded, its score by checkpoint, and
// its time, steps, mistakes and cost, with stalled runs kept out of the time medians.

const median = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const fmt = (x, d = 1) => (x === null || x === undefined ? "–" : Number(x).toFixed(d));

export function summarize(runs) {
  const byTask = new Map();
  for (const r of runs) byTask.set(r.task, [...(byTask.get(r.task) ?? []), r]);
  return [...byTask.entries()].map(([task, rs]) => {
    const timed = rs.filter((r) => !r.stalled && !r.error);
    const walls = timed.map((r) => r.wall);
    return {
      task,
      area: rs[0].area,
      safety: rs[0].safety === true,
      runs: rs.length,
      passed: rs.filter((r) => r.ok).length,
      score: median(rs.map((r) => r.score)),
      wall: median(walls),
      wallMin: walls.length ? Math.min(...walls) : null,
      wallMax: walls.length ? Math.max(...walls) : null,
      steps: median(rs.map((r) => r.steps)),
      wrong: median(rs.map((r) => r.wrong)),
      cost: median(rs.map((r) => r.cost)),
      peak: median(rs.map((r) => r.peak)),
      stalled: rs.filter((r) => r.stalled).length,
      errors: rs.filter((r) => r.error).length,
      failing: [...new Set(rs.flatMap((r) => (r.checkpoints ?? []).filter((c) => !c.ok).map((c) => c.name)))],
    };
  });
}

export function markdown(label, runs, meta = {}) {
  const rows = summarize(runs);
  const line = (s) => `| ${s.task} | ${s.passed}/${s.runs} | ${fmt(s.score * 100, 0)}% | ${fmt(s.wall)} (${fmt(s.wallMin, 0)}–${fmt(s.wallMax, 0)}) | ${fmt(s.steps, 0)} | ${fmt(s.wrong, 0)} | $${fmt(s.cost, 2)} | ${s.peak ? Math.round(s.peak / 1000) + "k" : "–"} | ${s.stalled ? s.stalled + " stalled" : ""}${s.errors ? ` ${s.errors} errored` : ""} |`;
  const head = "| Task | Passed | Score | Wall s, median (range) | Model calls | Wrong actions | Cost | Peak prompt | Notes |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const total = runs.reduce((n, r) => n + (r.cost ?? 0), 0);
  const failures = rows.filter((s) => s.failing.length).map((s) => `- **${s.task}**: ${s.failing.join("; ")}`);
  return [
    `# KOS evals: ${label}`,
    "",
    `${new Date().toISOString()} · ${runs.length} runs · token-equivalent cost $${total.toFixed(2)}${meta.root ? ` · build ${meta.root}` : ""}`,
    "",
    meta.engine ? `Engine: **${meta.engine.engine}** (the owner's Claude subscription through the Claude Agent SDK). KOS's own cheap calls: ${meta.engine.cheap ? `${meta.engine.cheap.provider} ${meta.engine.cheap.model}` : "default"}. Judge: Claude Haiku through the SDK.` : "",
    "",
    "## Tasks",
    "",
    head,
    ...rows.filter((s) => !s.safety).map(line),
    "",
    "## Safety (each must pass every run)",
    "",
    head,
    ...rows.filter((s) => s.safety).map(line),
    "",
    "## Checkpoints that failed at least once",
    "",
    ...(failures.length ? failures : ["- none"]),
    "",
  ].join("\n");
}

export function compare(a, b) {
  const sa = new Map(summarize(a.runs).map((s) => [s.task, s]));
  const sb = new Map(summarize(b.runs).map((s) => [s.task, s]));
  const names = [...new Set([...sa.keys(), ...sb.keys()])];
  const cell = (s) => (s ? `${s.passed}/${s.runs}, ${fmt(s.score * 100, 0)}%, ${fmt(s.wall)} s, ${fmt(s.steps, 0)} calls, $${fmt(s.cost, 2)}` : "not run");
  return [`| Task | ${a.label} | ${b.label} |`, "| --- | --- | --- |", ...names.map((n) => `| ${n} | ${cell(sa.get(n))} | ${cell(sb.get(n))} |`)].join("\n");
}
