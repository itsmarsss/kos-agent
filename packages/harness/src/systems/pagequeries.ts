import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";

import type { DisplayQueryResult } from "./display.js";

/**
 * Page queries, run apart from the server.
 *
 * A page's query is the agent's SQL run whenever the owner opens the page, and
 * SQLite cannot be interrupted from Node: a recursive CTE that never ends, or
 * randomblob(2e9), blocks the thread it runs on before it yields a row. On the
 * server's thread that was every request waiting on it. Here each query runs
 * in a child process with its own read-only connection, and one that is still
 * running at its deadline is killed outright and replaced. The server's thread
 * only waits on a message.
 */

/**
 * The child: one read-only connection, one query at a time, rows pulled to a
 * cap in count and in bytes, so a few huge values cannot fill the server's
 * memory when they arrive. It goes when the server does.
 */
const CHILD = `
const Database = require(process.argv[1]);
const db = new Database(process.argv[2], { readonly: true, fileMustExist: true });
db.pragma("busy_timeout = 2000");
process.on("disconnect", () => process.exit(0));
const sizeOf = (v) => (typeof v === "string" ? v.length * 2 : v && typeof v.length === "number" ? v.length : 8);
process.on("message", (job) => {
  try {
    const stmt = db.prepare(job.sql);
    if (!stmt.reader) throw new Error("the query did not produce a result set");
    const rows = [];
    let bytes = 0;
    let truncated = false;
    for (const row of stmt.iterate(...job.params)) {
      let size = 0;
      for (const k in row) size += k.length * 2 + sizeOf(row[k]);
      if (rows.length >= job.rowCap || bytes + size > job.byteCap) { truncated = true; break; }
      bytes += size;
      rows.push(row);
    }
    process.send({ id: job.id, rows, truncated });
  } catch (err) {
    process.send({ id: job.id, error: err && err.message ? err.message : String(err) });
  }
});
`;

export interface PageQueryOptions {
  /** Most rows returned (default 500). */
  rowCap?: number;
  /** Most bytes of values returned, counted as the child reads them (default 2 MB). */
  byteCap?: number;
  /** Past this, counted from when the query was asked, it is dropped or killed (default 2000 ms). */
  timeoutMs?: number;
  /** Who is asking, a page: each may have one query running and a few waiting, so none starves the rest. */
  key?: string;
}

/** A query that ran past its deadline and was stopped. */
export class QueryTimeout extends Error {}

/** A query refused because its page already has as many waiting as it may. */
export class QueryBusy extends Error {}

interface Job {
  id: number;
  key: string;
  sql: string;
  params: (string | number | null)[];
  rowCap: number;
  byteCap: number;
  timeoutMs: number;
  /** When it must be answered by, fixed when it was asked. */
  deadline: number;
  timer?: ReturnType<typeof setTimeout>;
  runner?: Runner;
  retried?: boolean;
  resolve: (r: DisplayQueryResult) => void;
  reject: (e: Error) => void;
}

interface Runner {
  child: ChildProcess;
  job?: Job;
  dead?: boolean;
}

const SQLITE = createRequire(import.meta.url).resolve("better-sqlite3");

export class PageQueries {
  private readonly idle: Runner[] = [];
  private readonly busy = new Set<Runner>();
  private readonly queue: Job[] = [];
  private readonly running = new Map<string, number>();
  private next = 1;
  private closed = false;

  constructor(
    private readonly dbPath: string,
    /** How many queries may run at once, over every page. */
    private readonly most = 3,
    /** How many one page may have running, and waiting. */
    private readonly perKey = { running: 1, waiting: 4 },
  ) {}

  run(sql: string, params: (string | number | null)[] = [], options: PageQueryOptions = {}): Promise<DisplayQueryResult> {
    if (this.closed) return Promise.reject(new Error("page queries are closed"));
    const key = options.key ?? "";
    if (this.queue.filter((j) => j.key === key).length >= this.perKey.waiting) {
      return Promise.reject(new QueryBusy("this page has too many queries waiting; try again when they finish"));
    }
    return new Promise((resolve, reject) => {
      const job: Job = {
        id: this.next++,
        key,
        sql,
        params,
        rowCap: options.rowCap ?? 500,
        byteCap: options.byteCap ?? 2_000_000,
        timeoutMs: options.timeoutMs ?? 2000,
        deadline: 0,
        resolve,
        reject,
      };
      // From when it was asked: time waiting for a turn counts.
      job.deadline = Date.now() + job.timeoutMs;
      this.arm(job);
      this.queue.push(job);
      this.pump();
    });
  }

  /** Stop every child, running or not; queries still waiting fail. */
  close(): void {
    this.closed = true;
    for (const r of [...this.idle.splice(0), ...this.busy]) r.child.kill("SIGKILL");
    for (const job of this.queue.splice(0)) this.settle(job).reject(new Error("page queries are closed"));
  }

  /** How many children are alive, for a test to see none is left behind. */
  get children(): ChildProcess[] {
    return [...this.idle, ...this.busy].map((r) => r.child);
  }

  /** A job whose child went: back to the front once, within its own deadline; a second time, it fails. */
  private again(job: Job): void {
    this.settle(job);
    if (job.retried || this.closed) {
      job.reject(new Error(this.closed ? "page queries are closed" : "the query's process ended"));
      return;
    }
    job.retried = true;
    this.arm(job);
    this.queue.unshift(job);
  }

  private arm(job: Job): void {
    job.timer = setTimeout(() => this.expire(job), Math.max(0, job.deadline - Date.now()));
    job.timer.unref?.();
  }

  private expire(job: Job): void {
    const waiting = this.queue.indexOf(job);
    if (waiting !== -1) this.queue.splice(waiting, 1);
    const runner = job.runner;
    // Still running at its deadline: the process goes, with whatever it was doing.
    if (runner) this.retire(runner);
    this.settle(job).reject(new QueryTimeout(`the query ran past ${job.timeoutMs} ms and was stopped`));
    this.pump();
  }

  /** A job done with, however: its timer cleared and its page's turn given back. */
  private settle(job: Job): Job {
    clearTimeout(job.timer);
    if (job.runner) {
      job.runner.job = undefined;
      job.runner = undefined;
      this.running.set(job.key, (this.running.get(job.key) ?? 1) - 1);
    }
    return job;
  }

  /** A runner that will not run again: killed, and forgotten. */
  private retire(runner: Runner): void {
    runner.dead = true;
    this.busy.delete(runner);
    const at = this.idle.indexOf(runner);
    if (at !== -1) this.idle.splice(at, 1);
    runner.child.kill("SIGKILL");
  }

  private spawn(): Runner {
    const child = spawn(process.execPath, ["-e", CHILD, SQLITE, this.dbPath], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    child.unref();
    const runner: Runner = { child };
    child.on("message", (m: { id: number; rows?: Record<string, unknown>[]; truncated?: boolean; error?: string }) => {
      const job = runner.job;
      if (!job || job.id !== m.id) return;
      this.settle(job);
      if (m.error !== undefined) job.reject(new Error(m.error));
      else job.resolve({ rows: m.rows ?? [], truncated: m.truncated === true });
      this.busy.delete(runner);
      if (this.closed || runner.dead) runner.child.kill("SIGKILL");
      else this.idle.push(runner);
      this.pump();
    });
    // A child that dies, idle or busy, is dropped; what it was running gets one more try.
    const died = (): void => {
      if (runner.dead) return;
      this.retire(runner);
      const job = runner.job;
      if (job) this.again(job);
      this.pump();
    };
    child.on("exit", died);
    child.on("error", died);
    return runner;
  }

  private alive(runner: Runner): boolean {
    return !runner.dead && !runner.child.killed && runner.child.connected && runner.child.exitCode === null && runner.child.signalCode === null;
  }

  private pump(): void {
    if (this.closed) return;
    while (this.busy.size < this.most) {
      const at = this.queue.findIndex((j) => (this.running.get(j.key) ?? 0) < this.perKey.running);
      if (at === -1) return;
      const job = this.queue.splice(at, 1)[0]!;
      let runner = this.idle.pop();
      while (runner && !this.alive(runner)) {
        this.retire(runner);
        runner = this.idle.pop();
      }
      runner ??= this.spawn();
      this.busy.add(runner);
      runner.job = job;
      job.runner = runner;
      this.running.set(job.key, (this.running.get(job.key) ?? 0) + 1);
      const sent = runner;
      sent.child.send({ id: job.id, sql: job.sql, params: job.params, rowCap: job.rowCap, byteCap: job.byteCap }, (err) => {
        if (!err || sent.job !== job) return;
        // The child went between the check and the send: once more on a fresh one.
        this.retire(sent);
        this.again(job);
        this.pump();
      });
    }
  }
}
