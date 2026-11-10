// Orchestration: asked at the root, KOS routes a task to the project it belongs to, and the work
// lands in that project's tables and nowhere else.

export default {
  name: "orchestration",
  area: "orchestration",
  title: "Asked at the root, KOS routes work to the right project and nowhere else",
  limitMs: 900_000,
  async setup(ctx) {
    ctx.garden = await ctx.project("Garden");
    ctx.workout = await ctx.project("Workout tracker");
    ctx.sql(`create table ${ctx.garden}_plants (id integer primary key, name text not null, bed text);
      insert into ${ctx.garden}_plants (name, bed) values ('tomatoes', 'south'), ('basil', 'south'), ('mint', 'pots');
      create table ${ctx.garden}_waterings (id integer primary key, plant_id integer not null references ${ctx.garden}_plants(id), litres real not null, day text not null);
      create table ${ctx.workout}_sessions (id integer primary key, day text not null, notes text);
      insert into ${ctx.workout}_sessions (day, notes) values ('2026-10-30', 'legs');`);
    ctx.before = ctx.tableCounts();
  },
  async run(ctx) {
    await ctx.turn(null, "Log that I watered the tomatoes and the basil this morning, 2 litres each.", { orchestrator: true });
  },
  async grade(ctx) {
    // A watering names its plant by id, as a project models it; a name in that column joins to nothing.
    const w = ctx.sql(`select w.plant_id, lower(p.name) as plant, w.litres, w.day from ${ctx.garden}_waterings w left join ${ctx.garden}_plants p on p.id = w.plant_id`);
    const after = ctx.tableCounts();
    const changed = Object.keys(after).filter((t) => after[t] !== ctx.before[t]);
    const outside = changed.filter((t) => !t.startsWith(`${ctx.garden}_`) && !/^(audit_log|token_usage|conversations|chat_|memory_|runs_log|pending_|settings|conversation_active|health_state|browser_frames|improvements|instance_config|kill_switch|button_routes|page_watches|devices|device_settings|surfaces|daemons|crons|pages|manifest|permission_rules|schema_migrations)/.test(t));
    const projectTurns = ctx.sql(`select count(*) as n from conversations where project_slug = '${ctx.garden}' and updated_at >= ${ctx.t0}`)[0]?.n ?? 0;
    return [
      ctx.check("two waterings logged in the garden's table", w.length === 2 && ["tomato", "basil"].every((p) => w.some((r) => r.plant?.includes(p) && Math.abs(r.litres - 2) < 0.01)), JSON.stringify(w)),
      ctx.check("nothing written to another project's tables", outside.length === 0, outside.join(", ") || "none"),
      ctx.check("the work went through the garden's own chat", projectTurns > 0, `${projectTurns} garden chat(s) touched`),
    ];
  },
};
