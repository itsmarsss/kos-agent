// Projects: a week of workouts told in plain words lands in an existing tracker's tables, and a
// question about them is answered from the data.

export default {
  name: "workout-log",
  area: "projects",
  title: "A week of workouts said in chat lands in the tracker; the best squat is found",
  limitMs: 600_000,
  async setup(ctx) {
    ctx.slug = await ctx.project("Workout tracker");
    ctx.sql(`create table ${ctx.slug}_sessions (id integer primary key, day text not null, notes text);
      create table ${ctx.slug}_sets (id integer primary key, session_id integer not null references ${ctx.slug}_sessions(id), exercise text not null, weight_kg real, reps integer);
      insert into ${ctx.slug}_sessions (id, day, notes) values (1, '2026-10-19', 'legs'), (2, '2026-10-21', 'upper');
      insert into ${ctx.slug}_sets (session_id, exercise, weight_kg, reps) values (1, 'squat', 95, 5), (1, 'squat', 95, 5), (1, 'squat', 95, 5), (2, 'bench press', 67.5, 5), (2, 'bench press', 67.5, 5);`);
  },
  async run(ctx) {
    const chat = await ctx.chat("Training log", ctx.slug);
    await ctx.turn(chat, "Log last week's training: Monday 26 Oct, squat 100 kg for 3 sets of 5 and bench press 70 kg for 3 sets of 5. Wednesday 28 Oct, squat 105 kg for 2 sets of 3 and deadlift 140 kg for one set of 5. Friday 30 Oct, squat 102.5 kg for 3 sets of 4. Saturday 31 Oct, deadlift 145 kg for one set of 3. Tuesday, Thursday and Sunday were rest days.");
    ctx.answer = (await ctx.turn(chat, "What was my best squat ever, and when was it?")).answer;
  },
  async grade(ctx) {
    const s = ctx.slug;
    const rows = ctx.sql(`select x.day, lower(t.exercise) as exercise, t.weight_kg as w, t.reps from ${s}_sets t join ${s}_sessions x on x.id = t.session_id where x.day >= '2026-10-26'`);
    const has = (day, ex, w) => rows.some((r) => r.day === day && r.exercise.includes(ex) && Math.abs(r.w - w) < 0.01);
    const sets = (day, ex, w) => rows.filter((r) => r.day === day && r.exercise.includes(ex) && Math.abs(r.w - w) < 0.01).length;
    const tables = ctx.sql(`select name from sqlite_master where type='table' and name like '${s}\\_%' escape '\\'`).map((t) => t.name);
    return [
      ctx.check("four training days are logged with their dates", ["2026-10-26", "2026-10-28", "2026-10-30", "2026-10-31"].every((d) => rows.some((r) => r.day === d)), `${new Set(rows.map((r) => r.day)).size} days`),
      ctx.check("every lift is there at its weight", has("2026-10-26", "squat", 100) && has("2026-10-26", "bench", 70) && has("2026-10-28", "squat", 105) && has("2026-10-28", "dead", 140) && has("2026-10-30", "squat", 102.5) && has("2026-10-31", "dead", 145), `${rows.length} rows`),
      ctx.check("one row per set, as the tracker keeps them", sets("2026-10-26", "squat", 100) === 3 && sets("2026-10-28", "squat", 105) === 2 && sets("2026-10-30", "squat", 102.5) === 3, `squat sets: ${sets("2026-10-26", "squat", 100)}, ${sets("2026-10-28", "squat", 105)}, ${sets("2026-10-30", "squat", 102.5)}`),
      ctx.check("it used the tracker's tables rather than new ones", tables.length === 2, tables.join(", ")),
      ctx.check("the best squat is 105 kg on 28 October", /105/.test(ctx.answer ?? "") && /28|wednesday/i.test(ctx.answer ?? ""), (ctx.answer ?? "").slice(0, 160)),
    ];
  },
};
