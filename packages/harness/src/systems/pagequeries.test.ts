import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DB_FILENAME, Workspace } from "../store/workspace.js";
import { PageQueries, QueryBusy, QueryTimeout } from "./pagequeries.js";

const NEVER = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT COUNT(*) FROM n";
const alive = (pid: number | undefined): boolean => {
  try {
    process.kill(pid!, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (check: () => boolean, ms = 3000): Promise<void> => {
  for (const end = Date.now() + ms; !check() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 20));
};

/** Where page queries run: apart, bounded in time, bytes and turns, and leaving nothing behind. */
describe("page queries", () => {
  let root: string;
  let ws: Workspace;
  let queries: PageQueries;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-pq-"));
    ws = Workspace.open(root);
    ws.db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    queries = new PageQueries(join(ws.root, DB_FILENAME));
  });

  afterEach(() => {
    queries.close();
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("stops at a cap in bytes, not only in rows, and says it did", async () => {
    const big = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20) SELECT printf('%.*c', 3000000, 'x') AS v FROM n";
    const res = await queries.run(big, [], { timeoutMs: 10_000 });
    expect(res.truncated).toBe(true);
    expect(res.rows.length).toBeLessThan(2);
    const small = await queries.run("SELECT printf('%.*c', 1000, 'x') AS v", []);
    expect(small).toMatchObject({ truncated: false, rows: [{ v: "x".repeat(1000) }] });
  });

  it("lets one page queue only a few, and its queries never hold another page's", async () => {
    const mine = Array.from({ length: 100 }, () => queries.run(NEVER, [], { key: "greedy", timeoutMs: 1500 }).catch((e: Error) => e));
    const started = Date.now();
    const other = await queries.run("SELECT 1 AS one", [], { key: "other" });
    expect(other.rows).toEqual([{ one: 1 }]);
    expect(Date.now() - started).toBeLessThan(800);
    const outcomes = await Promise.all(mine);
    expect(outcomes.filter((e) => e instanceof QueryBusy).length).toBeGreaterThanOrEqual(95);
    expect(outcomes.every((e) => e instanceof QueryBusy || e instanceof QueryTimeout)).toBe(true);
  });

  it("counts a query's time from when it was asked, waiting included", async () => {
    void queries.run(NEVER, [], { key: "p", timeoutMs: 800 }).catch(() => undefined);
    const started = Date.now();
    const queued = await queries.run("SELECT 1", [], { key: "p", timeoutMs: 400 }).catch((e: Error) => e);
    expect(queued).toBeInstanceOf(QueryTimeout);
    expect(Date.now() - started).toBeLessThan(700);
  });

  it("leaves no child behind when closed, busy ones included", async () => {
    await Promise.all([queries.run("SELECT 1", [], { key: "a" }), queries.run("SELECT 1", [], { key: "c" })]);
    const running = queries.run(NEVER, [], { key: "b", timeoutMs: 10_000 }).catch((e: Error) => e);
    await new Promise((r) => setTimeout(r, 100));
    const pids = queries.children.map((c) => c.pid);
    expect(pids.length).toBe(2);
    queries.close();
    await until(() => pids.every((p) => !alive(p)));
    expect(pids.filter(alive)).toEqual([]);
    expect(await running).toBeInstanceOf(Error);
  });

  it("answers the next query when an idle child has died", async () => {
    await queries.run("SELECT 1", []);
    const [child] = queries.children;
    child!.kill("SIGKILL");
    // Asked at once, before the exit is heard, and again after.
    expect((await queries.run("SELECT 2 AS n", [])).rows).toEqual([{ n: 2 }]);
    await until(() => child!.exitCode !== null || child!.signalCode !== null);
    const [next] = queries.children;
    next!.kill("SIGKILL");
    await until(() => next!.signalCode !== null);
    expect((await queries.run("SELECT 3 AS n", [])).rows).toEqual([{ n: 3 }]);
  });
});
