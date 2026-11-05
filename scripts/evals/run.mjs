#!/usr/bin/env node
// KOS evals: tasks in the shape of what KOS is for, each run several times on a fresh scratch KOS,
// graded on what ended up in the workspace and on the fake devices rather than on wording.
//
//   node scripts/evals/run.mjs --label main [--tasks all|<area>|<name>,...] [--runs 3] [--port 4417] \
//     [--root <checkout under test>] [--settings-from <workspace>] [--env <owner .env>] \
//     [--scratch-env <file of extra env>] [--out evals-out] [--keep]
//   node scripts/evals/run.mjs --compare evals-out/main.json evals-out/branch.json
//
// Never point it at the owner's KOS: it pairs fake devices, starts chats and answers approvals.
// See scripts/evals/README.md.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { launchChrome } from "./lib/chrome.mjs";
import { fakeMac } from "./lib/desktop.mjs";
import { Host, copyWorkspace, portFree, sql as host_sql, template } from "./lib/host.mjs";
import { makeJudge } from "./lib/judge.mjs";
import { Kos, sdkCalls } from "./lib/kos.mjs";
import { chromePanel } from "./lib/panel.mjs";
import { compare, markdown } from "./lib/report.mjs";
import { startSites } from "./lib/sites.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? "true" : all[i + 1]]] : acc), []));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (args.compare) {
  const [a, b] = [args.compare, process.argv.at(-1)].map((p) => JSON.parse(readFileSync(p, "utf8")));
  console.log(compare(a, b));
  process.exit(0);
}

const ROOT = resolve(args.root ?? join(HERE, "../.."));
const LABEL = args.label ?? "run";
const OUT = resolve(args.out ?? join(ROOT, "evals-out"));
const RUNS = Number(args.runs ?? 3);
const PORT = Number(args.port ?? 4417);
const ENV = resolve(args.env ?? join(ROOT, ".env"));
const extraEnv = {};
if (args["scratch-env"]) for (const l of readFileSync(args["scratch-env"], "utf8").split("\n")) if (/^[A-Z_]+=/.test(l)) extraEnv[l.slice(0, l.indexOf("="))] = l.slice(l.indexOf("=") + 1);

const ALL = [];
for (const f of readdirSync(join(HERE, "tasks")).filter((f) => f.endsWith(".mjs")).sort()) ALL.push((await import(join(HERE, "tasks", f))).default);
const wanted = (args.tasks ?? "all").split(",");
const TASKS = ALL.filter((t) => wanted.includes("all") || wanted.includes(t.name) || wanted.includes(t.area) || (wanted.includes("safety") && t.safety));
if (!TASKS.length) throw new Error(`no task matches ${args.tasks}; there are ${ALL.map((t) => t.name).join(", ")}`);
if (!(await portFree(PORT))) throw new Error(`something already answers on ${PORT}; stop it first (never the owner's KOS)`);
if (!existsSync(join(ROOT, "packages/cli/dist/main.js"))) throw new Error(`${ROOT} is not built: pnpm exec tsc -b there first`);

mkdirSync(OUT, { recursive: true });
const runsDir = join(OUT, "runs", LABEL);
log(`evals ${LABEL}: ${TASKS.length} tasks x ${RUNS} runs on ${ROOT}`);
const tpl = await template({ root: ROOT, dir: join(OUT, "template"), port: PORT, envSource: ENV, extraEnv, settingsFrom: args["settings-from"] });
/** The engine and models every run uses, read from the template: the owner's chats run on the SDK engine, so the evals must. */
const behaviour = JSON.parse(host_sql(tpl, "select value from settings where key = 'behaviour'")[0]?.value ?? "{}");
const models = JSON.parse(host_sql(tpl, "select value from settings where key = 'models'")[0]?.value ?? "{}");
const ENGINE = { engine: behaviour.engine ?? "api", cheap: models.cheap ?? null, reasoning: models.reasoning ?? null };
if (ENGINE.engine !== "sdk" && !args["any-engine"]) throw new Error(`the template runs on the ${ENGINE.engine} engine; the evals run on the SDK engine (pass --settings-from a workspace set to it, or --any-engine)`);
const sites = await startSites();
const judge = makeJudge(ROOT);
const results = existsSync(join(OUT, `${LABEL}.json`)) && args.resume ? JSON.parse(readFileSync(join(OUT, `${LABEL}.json`), "utf8")).runs : [];
const save = () => {
  writeFileSync(join(OUT, `${LABEL}.json`), JSON.stringify({ label: LABEL, root: ROOT, engine: ENGINE, at: new Date().toISOString(), runs: results }, null, 1));
  writeFileSync(join(OUT, `${LABEL}.md`), markdown(LABEL, results, { root: ROOT, engine: ENGINE }));
};

for (const task of TASKS) {
  for (let n = 1; n <= RUNS; n++) {
    if (results.some((r) => r.task === task.name && r.n === n)) continue;
    const dir = join(runsDir, task.name, String(n));
    copyWorkspace(tpl, join(dir, "ws"));
    const host = new Host({ root: ROOT, dir, port: PORT, envSource: ENV, extraEnv });
    const record = { task: task.name, area: task.area, safety: task.safety === true, n, dir };
    let chrome;
    let mac;
    try {
      const engine = JSON.parse(host_sql(join(dir, "ws"), "select value from settings where key = 'behaviour'")[0]?.value ?? "{}").engine;
      record.engine = engine;
      if (engine !== ENGINE.engine) throw new Error(`run workspace is on the ${engine} engine, not ${ENGINE.engine}`);
      await host.start();
      sites.reset();
      const kos = new Kos(host, log);
      kos.policy = task.policy ?? "approve";
      const needs = task.needs ?? [];
      if (needs.length || task.setup?.toString().includes("ctx.pdf")) chrome = await launchChrome();
      const ctx = makeCtx({ host, kos, sites, chrome, judge });
      if (needs.includes("mac")) {
        const q = task.mac?.query ? `?${task.mac.query}` : "";
        mac = await fakeMac({ root: ROOT, kos, chrome, deskUrl: `${sites.url}/desktop${q}`, setup: task.mac?.setup ?? {} });
        ctx.mac = mac;
      }
      if (task.setup) await task.setup(ctx);
      if (needs.includes("chrome")) {
        const panel = await chromePanel({ chrome, kos, extDist: join(ROOT, "packages/browser-extension/dist"), workDir: dir, tabUrl: `${sites.url}${task.chrome.tab}` });
        ctx.say = async (text, o) => ctx.track(await panel.say(text, o));
        ctx.panel = panel;
      }
      ctx.t0 = Date.now();
      const limit = task.limitMs ?? 900_000;
      const outcome = await Promise.race([task.run(ctx).then(() => "done"), sleep(limit + 60_000).then(() => "timed out")]);
      ctx.t1 = Date.now();
      await sleep(1500);
      ctx.calls = sdkCalls(host.workspace, ctx.t0, ctx.t1);
      ctx.tools = kos.toolCalls(ctx.t0);
      ctx.approvals = kos.approvals;
      const usage = kos.usage(ctx.t0);
      const checkpoints = await task.grade(ctx);
      const required = checkpoints.filter((c) => c.required !== false);
      const desk = mac ? await mac.state().catch(() => undefined) : undefined;
      Object.assign(record, {
        ok: outcome === "done" && required.every((c) => c.ok),
        score: checkpoints.length ? checkpoints.filter((c) => c.ok).length / checkpoints.length : 0,
        checkpoints,
        outcome,
        wall: (ctx.t1 - ctx.t0) / 1000,
        turns: ctx.turns.map((t) => ({ wall: t.wall, timedOut: t.timedOut, answer: String(t.answer ?? "").slice(0, 400) })),
        steps: ctx.calls.length,
        modelS: ctx.calls.reduce((s, c) => s + c.modelMs, 0) / 1000,
        toolS: ctx.calls.reduce((s, c) => s + c.toolMs, 0) / 1000,
        stalled: ctx.calls.some((c) => c.modelMs > 120_000),
        peak: Math.max(0, ...ctx.calls.map((c) => c.input + c.cached + c.written)),
        tools: Object.entries(ctx.tools.reduce((m, t) => ({ ...m, [t.tool]: { n: (m[t.tool]?.n ?? 0) + 1, errors: (m[t.tool]?.errors ?? 0) + (t.isError ? 1 : 0) } }), {})).map(([name, v]) => ({ name, ...v })),
        toolErrors: ctx.tools.filter((t) => t.isError).map((t) => ({ tool: t.tool, result: String(t.result).slice(0, 300) })),
        wrong: ctx.tools.filter((t) => t.isError).length + (desk?.misclicks ?? 0),
        misclicks: desk?.misclicks,
        approvals: kos.approvals,
        deviceErrors: mac ? mac.calls.filter((c) => !c.ok) : undefined,
        ...usage,
      });
      log(task.name, n, record.ok ? "PASS" : "FAIL", `${record.wall.toFixed(0)} s`, `${record.steps} calls`, `$${(record.cost ?? 0).toFixed(2)}`, checkpoints.map((c) => `${c.ok ? "✓" : "✗"} ${c.name}`).join(" | "));
    } catch (err) {
      Object.assign(record, { ok: false, score: 0, error: String(err?.stack ?? err).slice(0, 2000), wall: null, steps: 0, wrong: 0, cost: 0 });
      log(task.name, n, "ERROR", String(err?.message ?? err));
    } finally {
      await mac?.close().catch(() => undefined);
      chrome?.close();
      await host.stop();
      if (!args.keep) rmSync(join(dir, "ws"), { recursive: true, force: true });
    }
    results.push(record);
    save();
  }
}
sites.close();
save();
log("wrote", join(OUT, `${LABEL}.json`), "and", `${LABEL}.md`);
process.exit(0);

/** What a task sees: the owner's moves, and the workspace to check. */
function makeCtx({ host, kos, sites, chrome, judge }) {
  const ctx = {
    host,
    kos,
    sites,
    chrome,
    judge,
    turns: [],
    t0: Date.now(),
    track(t) {
      ctx.turns.push(t);
      return t;
    },
    chat: (title, projectSlug) => kos.newChat(title, projectSlug),
    turn: async (chat, text, o = {}) => ctx.track(await kos.turn(chat, text, o)),
    wait: (ms) => sleep(ms),
    sql: (q) => host.sql(q),
    readFile(rel) {
      const p = join(host.workspace, rel);
      return existsSync(p) ? readFileSync(p, "utf8") : null;
    },
    writeFile(rel, content) {
      const p = join(host.workspace, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    },
    async project(name) {
      const made = await kos.api("/api/projects/create", { name });
      if (!made.slug) throw new Error(`could not make project ${name}: ${JSON.stringify(made)}`);
      return made.slug;
    },
    /** A fixture page printed to a PDF in the workspace. */
    async pdf(rel, path) {
      const page = await chrome.open(`${sites.url}${path}`);
      await sleep(900);
      const { data } = await chrome.send("Page.printToPDF", { printBackground: false }, page.session);
      const p = join(host.workspace, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, Buffer.from(data, "base64"));
    },
    /** Rows in every table a project could own: to tell what a turn changed. */
    tableCounts() {
      const out = {};
      for (const { name } of host.sql("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '%_fts%' and name not like '%vec%'")) {
        out[name] = host.sql(`select count(*) as n from "${name}"`)[0]?.n ?? 0;
      }
      return out;
    },
    check: (name, ok, detail = "", o = {}) => ({ name, ok: !!ok, detail: String(detail).slice(0, 400), ...o }),
  };
  return ctx;
}
