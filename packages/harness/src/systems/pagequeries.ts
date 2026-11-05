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

/** The child: one read-only connection, one query at a time, rows pulled to a cap. */
const CHILD = `
const Database = require(process.argv[1]);
const db = new Database(process.argv[2], { readonly: true, fileMustExist: true });
db.pragma("busy_timeout = 2000");
process.on("message", (job) => {
  try {
    const stmt = db.prepare(job.sql);
    if (!stmt.reader) throw new Error("the query did not produce a result set");
    const rows = [];
    let truncated = false;
    for (const row of stmt.iterate(...job.params)) {
      if (rows.length >= job.rowCap) { truncated = true; break; }
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
  /** Past this, the query is killed (default 2000 ms). */
  timeoutMs?: number;
}

/** A query that ran past its deadline and was killed. */
export class QueryTimeout extends Error {}

interface Job {
  id: number;
  sql: string;
  params: (string | number | null)[];
  rowCap: number;
  timeoutMs: number;
  resolve: (r: DisplayQueryResult) => void;
  reject: (e: Error) => void;
}

interface Runner {
  child: ChildProcess;
  job?: Job;
  timer?: ReturnType<typeof setTimeout>;
}

const SQLITE = createRequire(import.meta.url).resolve("better-sqlite3");

export class PageQueries {
  private readonly idle: Runner[] = [];
  private readonly queue: Job[] = [];
  private busy = 0;
  private next = 1;
  private closed = false;

  constructor(
    private readonly dbPath: string,
    /** How many queries may run at once. */
    private readonly most = 3,
  ) {}

  run(sql: string, params: (string | number | null)[] = [], options: PageQueryOptions = {}): Promise<DisplayQueryResult> {
    if (this.closed) return Promise.reject(new Error("page queries are closed"));
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.next++, sql, params, rowCap: options.rowCap ?? 500, timeoutMs: options.timeoutMs ?? 2000, resolve, reject });
      this.pump();
    });
  }

  /** Stop every child; queries still waiting fail. */
  close(): void {
    this.closed = true;
    for (const r of this.idle.splice(0)) r.child.kill("SIGKILL");
    for (const job of this.queue.splice(0)) job.reject(new Error("page queries are closed"));
  }

  private spawn(): Runner {
    const child = spawn(process.execPath, ["-e", CHILD, SQLITE, this.dbPath], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    child.unref();
    const runner: Runner = { child };
    child.on("message", (m: { id: number; rows?: Record<string, unknown>[]; truncated?: boolean; error?: string }) => {
      const job = runner.job;
      if (!job || job.id !== m.id) return;
      this.finish(runner);
      if (m.error !== undefined) job.reject(new Error(m.error));
      else job.resolve({ rows: m.rows ?? [], truncated: m.truncated === true });
      this.release(runner);
    });
    child.on("exit", () => {
      const job = runner.job;
      if (!job) return;
      this.finish(runner);
      job.reject(new Error("the query's process ended"));
      this.busy -= 1;
      this.pump();
    });
    return runner;
  }

  private finish(runner: Runner): void {
    clearTimeout(runner.timer);
    runner.timer = undefined;
    runner.job = undefined;
  }

  private release(runner: Runner): void {
    this.busy -= 1;
    if (this.closed) runner.child.kill("SIGKILL");
    else this.idle.push(runner);
    this.pump();
  }

  private pump(): void {
    while (this.queue.length && this.busy < this.most) {
      const job = this.queue.shift()!;
      const runner = this.idle.pop() ?? this.spawn();
      this.busy += 1;
      runner.job = job;
      runner.timer = setTimeout(() => {
        // Still running at its deadline: the process goes, with whatever it was doing.
        runner.job = undefined;
        runner.child.removeAllListeners("exit");
        runner.child.kill("SIGKILL");
        this.busy -= 1;
        job.reject(new QueryTimeout(`the query ran past ${job.timeoutMs} ms and was stopped`));
        this.pump();
      }, job.timeoutMs);
      runner.timer.unref?.();
      runner.child.send({ id: job.id, sql: job.sql, params: job.params, rowCap: job.rowCap });
    }
  }
}
