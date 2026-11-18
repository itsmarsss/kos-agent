import { describe, expect, it } from "vitest";

import { openDatabase } from "./db.js";

const scrub = (text: string): string => text.replaceAll("sk-db-canary", "[secret stripe]");

describe("openDatabase with a scrub", () => {
  const db = openDatabase(":memory:", () => scrub);
  db.exec(`CREATE TABLE t (a TEXT, b BLOB, n INTEGER)`);

  it("scrubs positional, array and named string parameters, and leaves blobs and numbers", () => {
    db.prepare(`INSERT INTO t (a, b, n) VALUES (?, ?, ?)`).run("one sk-db-canary", Buffer.from("sk-db-canary"), 1);
    db.prepare(`INSERT INTO t (a, b, n) VALUES (?, ?, ?)`).run(["two sk-db-canary", null, 2]);
    db.prepare(`INSERT INTO t (a, b, n) VALUES (@a, @b, @n)`).run({ a: "three sk-db-canary", b: null, n: 3 });
    const rows = db.prepare(`SELECT a, b, n FROM t ORDER BY n`).all() as { a: string; b: Buffer | null; n: number }[];
    expect(rows.map((r) => r.a)).toEqual(["one [secret stripe]", "two [secret stripe]", "three [secret stripe]"]);
    expect(rows[0]!.b?.toString()).toBe("sk-db-canary");
  });

  it("keeps chaining, transactions and the rest of the API working", () => {
    const insert = db.prepare(`INSERT INTO t (a, n) VALUES (?, ?)`);
    db.transaction(() => insert.run("in a transaction sk-db-canary", 4))();
    expect(db.prepare(`SELECT a FROM t WHERE n = ?`).pluck().get(4)).toBe("in a transaction [secret stripe]");
    expect(db.prepare(`SELECT a FROM t WHERE n = 4`).raw().all()).toEqual([["in a transaction [secret stripe]"]]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.open).toBe(true);
  });

  it("writes as given with no scrub set", () => {
    const plain = openDatabase(":memory:", () => undefined);
    plain.exec(`CREATE TABLE t (a TEXT)`);
    plain.prepare(`INSERT INTO t VALUES (?)`).run("sk-db-canary");
    expect(plain.prepare(`SELECT a FROM t`).pluck().get()).toBe("sk-db-canary");
  });
});
