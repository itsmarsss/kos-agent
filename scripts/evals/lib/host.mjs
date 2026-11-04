// A scratch KOS per run: a fresh copy of a template workspace, a host of its own
// on one port, the owner's model keys and nothing else of theirs.

import { execFileSync, spawn } from "node:child_process";
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The env a scratch host runs with: the model keys from the owner's .env, every channel blanked. */
function envFile(source) {
  const keep = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "NODE_ENV"];
  const lines = existsSync(source) ? readFileSync(source, "utf8").split("\n") : [];
  const kept = lines.filter((l) => keep.some((k) => l.startsWith(`${k}=`)));
  return [...kept, "DISCORD_TOKEN=", "KOS_OWNER_DISCORD=", "KOS_DISCORD_GUILD=", "KOS_OWNER_IMESSAGE=", ""].join("\n");
}

/** Run SQL against a workspace's database with the sqlite3 CLI; rows as objects. */
export function sql(workspace, query) {
  const out = execFileSync("sqlite3", ["-json", join(workspace, "kos.sqlite"), query], { encoding: "utf8", timeout: 20_000 }).trim();
  return out ? JSON.parse(out) : [];
}

export class Host {
  /**
   * @param {object} o
   * @param {string} o.root   the KOS checkout whose build is under test (its packages/cli/dist)
   * @param {string} o.dir    where this host's workspace, env and log live
   * @param {number} o.port
   * @param {string} o.envSource the owner's .env, for model keys only
   * @param {Record<string,string>} o.extraEnv
   */
  constructor(o) {
    Object.assign(this, o);
    this.workspace = join(o.dir, "ws");
    this.url = `http://127.0.0.1:${o.port}`;
  }

  async start() {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, ".env"), envFile(this.envSource));
    const log = openSync(join(this.dir, "host.log"), "a");
    // Detached and on its own log, so the runner can be stopped without the host, and the other way round.
    this.proc = spawn("node", [join(this.root, "packages/cli/dist/main.js"), "serve", "--workspace", this.workspace, "--host", "127.0.0.1", "--port", String(this.port)], {
      cwd: this.dir,
      env: { ...process.env, DISCORD_TOKEN: "", KOS_OWNER_DISCORD: "", KOS_DISCORD_GUILD: "", KOS_OWNER_IMESSAGE: "", ...this.extraEnv },
      stdio: ["ignore", log, log],
      detached: true,
    });
    this.proc.unref();
    closeSync(log);
    for (let i = 0; i < 120; i++) {
      const ok = await fetch(`${this.url}/api/status`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok).catch(() => false);
      if (ok) return this;
      if (this.proc.exitCode !== null) break;
      await sleep(500);
    }
    throw new Error(`host on ${this.port} did not come up; see ${join(this.dir, "host.log")}`);
  }

  async stop() {
    if (!this.proc || this.proc.exitCode !== null) return;
    try {
      process.kill(this.proc.pid, "SIGTERM");
    } catch {
      return;
    }
    for (let i = 0; i < 40 && this.proc.exitCode === null; i++) await sleep(250);
    if (this.proc.exitCode === null) {
      try {
        process.kill(this.proc.pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
    await sleep(300);
  }

  sql(query) {
    return sql(this.workspace, query);
  }
}

/** Nothing else may be listening where a run's host will. */
export async function portFree(port) {
  return !(await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(1500) }).then(() => true).catch(() => false));
}

/**
 * The template every run copies: a workspace made by a fresh host, with the engine and
 * models of a reference workspace, its schedules off. Built once and reused.
 */
export async function template({ root, dir, port, envSource, extraEnv, settingsFrom }) {
  const ws = join(dir, "ws");
  if (existsSync(join(ws, "kos.sqlite")) && existsSync(join(dir, "ready"))) return ws;
  rmSync(dir, { recursive: true, force: true });
  const host = new Host({ root, dir, port, envSource, extraEnv });
  await host.start();
  await host.stop();
  if (settingsFrom) {
    const copy = join(dir, "ref.sqlite");
    cpSync(join(settingsFrom, "kos.sqlite"), copy);
    const ref = JSON.parse(execFileSync("sqlite3", ["-json", copy, "select key, value from settings where key in ('behaviour','models')"], { encoding: "utf8" }) || "[]");
    for (const { key, value } of ref) {
      // The caretaker stays off: a failed eval step would otherwise open a repair chat and spend on it.
      const v = key === "behaviour" ? JSON.stringify({ ...JSON.parse(value), autoFix: false }) : String(value);
      sql(ws, `insert into settings (key, value, updated_at) values ('${key}', '${v.replaceAll("'", "''")}', ${Date.now()}) on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`);
    }
    if (existsSync(join(settingsFrom, "profile.json"))) cpSync(join(settingsFrom, "profile.json"), join(ws, "profile.json"));
    rmSync(copy, { force: true });
  }
  sql(ws, "update crons set enabled = 0; update daemons set enabled = 0;");
  writeFileSync(join(dir, "ready"), new Date().toISOString());
  return ws;
}

/** A run's workspace: the template, copied whole (the database with its WAL folded in first). */
export function copyWorkspace(templateWs, dest) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(resolve(dest, ".."), { recursive: true });
  execFileSync("sqlite3", [join(templateWs, "kos.sqlite"), "pragma wal_checkpoint(truncate);"], { timeout: 20_000 });
  cpSync(templateWs, dest, { recursive: true });
}
