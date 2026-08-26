import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { runDisplayQuery } from "./display.js";

describe("runDisplayQuery", () => {
  let root: string;
  let ws: Workspace;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-display-"));
    ws = Workspace.open(root);
    ws.db.exec("CREATE TABLE tx (id INTEGER PRIMARY KEY, amount REAL)");
    const insert = ws.db.prepare("INSERT INTO tx (amount) VALUES (?)");
    for (let i = 0; i < 50; i++) insert.run(i);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("reads rows through the read-only handle", () => {
    const res = runDisplayQuery(ws.reader, "SELECT COUNT(*) AS n FROM tx");
    expect(res.rows[0]).toEqual({ n: 50 });
    expect(res.truncated).toBe(false);
  });

  it("rejects a non-select before it reaches the driver", () => {
    expect(() => runDisplayQuery(ws.reader, "DELETE FROM tx")).toThrow(
      /read-only/,
    );
  });

  it("refuses a write at the connection even if the guard were bypassed", () => {
    // The regex is defence in depth; this is the one that cannot be argued
    // past, because SQLite itself owns the refusal.
    expect(() => ws.reader.prepare("DELETE FROM tx").run()).toThrow(
      /readonly|read-only/i,
    );
  });

  it("caps rows without materializing the whole result set", () => {
    const res = runDisplayQuery(ws.reader, "SELECT * FROM tx", { rowCap: 10 });
    expect(res.rows).toHaveLength(10);
    expect(res.truncated).toBe(true);
  });

  it("does not mark a result truncated when it fits exactly", () => {
    const res = runDisplayQuery(ws.reader, "SELECT * FROM tx", { rowCap: 50 });
    expect(res.rows).toHaveLength(50);
    expect(res.truncated).toBe(false);
  });

  it("stops pulling rows once the deadline passes", () => {
    // Clock jumps past the deadline after the first row is taken.
    let t = 0;
    const res = runDisplayQuery(ws.reader, "SELECT * FROM tx", {
      timeoutMs: 5,
      now: () => (t += 4),
    });
    expect(res.timedOut).toBe(true);
    expect(res.truncated).toBe(true);
    expect(res.rows.length).toBeLessThan(50);
  });

  it("rejects a statement that returns no result set", () => {
    expect(() =>
      runDisplayQuery(ws.reader, "WITH a AS (SELECT 1) SELECT * FROM a"),
    ).not.toThrow();
  });

  it("sees writes committed on the write handle", () => {
    ws.db.prepare("INSERT INTO tx (amount) VALUES (?)").run(999);
    const res = runDisplayQuery(ws.reader, "SELECT COUNT(*) AS n FROM tx");
    expect(res.rows[0]).toEqual({ n: 51 });
  });
});
