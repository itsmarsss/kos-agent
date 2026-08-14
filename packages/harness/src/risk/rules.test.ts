import { describe, expect, it } from "vitest";

import {
  domainAllowlistEscalation,
  isAdditiveMigration,
  isSqlWrite,
  migrationEscalation,
  pathOutsideScratchEscalation,
  sqlWriteEscalation,
} from "./rules.js";

describe("isSqlWrite", () => {
  it("detects write and DDL statements", () => {
    expect(isSqlWrite("INSERT INTO t VALUES (1)")).toBe(true);
    expect(isSqlWrite("update t set x=1")).toBe(true);
    expect(isSqlWrite("DROP TABLE t")).toBe(true);
  });

  it("treats reads as non-writes", () => {
    expect(isSqlWrite("SELECT * FROM t")).toBe(false);
  });
});

describe("sqlWriteEscalation", () => {
  const escalate = sqlWriteEscalation(["accounts", "secrets"]);

  it("escalates a write touching a sensitive table", () => {
    expect(escalate({ sql: "UPDATE accounts SET balance=0" })).toBe(true);
  });

  it("does not escalate a read of a sensitive table", () => {
    expect(escalate({ sql: "SELECT * FROM accounts" })).toBe(false);
  });

  it("does not escalate a write to a non-sensitive table", () => {
    expect(escalate({ sql: "INSERT INTO notes VALUES (1)" })).toBe(false);
  });

  it("ignores missing sql input", () => {
    expect(escalate({})).toBe(false);
  });
});

describe("domainAllowlistEscalation", () => {
  const escalate = domainAllowlistEscalation(["api.example.com"]);

  it("allows an allowlisted host", () => {
    expect(escalate({ url: "https://api.example.com/v1" })).toBe(false);
  });

  it("escalates a non-allowlisted host", () => {
    expect(escalate({ url: "https://evil.test/x" })).toBe(true);
  });

  it("escalates an unparseable url", () => {
    expect(escalate({ url: "not a url" })).toBe(true);
    expect(escalate({})).toBe(true);
  });
});

describe("pathOutsideScratchEscalation", () => {
  const escalate = pathOutsideScratchEscalation("scratch");

  it("allows a path inside the scratch prefix", () => {
    expect(escalate({ path: "scratch/tmp.txt" })).toBe(false);
    expect(escalate({ path: "scratch" })).toBe(false);
  });

  it("escalates a path outside scratch", () => {
    expect(escalate({ path: "projects/data.txt" })).toBe(true);
  });

  it("escalates traversal and prefix-spoofing", () => {
    expect(escalate({ path: "scratch/../etc" })).toBe(true);
    expect(escalate({ path: "scratchpad/x" })).toBe(true);
  });

  it("escalates a missing path", () => {
    expect(escalate({})).toBe(true);
  });
});

describe("isAdditiveMigration", () => {
  // Every op in ChangeSpec, plus what each classification means for approval.
  const cases: Array<{ name: string; spec: unknown; additive: boolean }> = [
    {
      name: "create_table",
      spec: { op: "create_table", table: "tx", columns: [{ name: "id", type: "INTEGER" }] },
      additive: true,
    },
    {
      name: "add_column",
      spec: { op: "add_column", table: "tx", column: { name: "note", type: "TEXT" } },
      additive: true,
    },
    {
      name: "create_index",
      spec: { op: "create_index", table: "tx", columns: ["date"] },
      additive: true,
    },
    {
      name: "drop_column",
      spec: { op: "drop_column", table: "tx", column: "note" },
      additive: false,
    },
    {
      name: "rename_column",
      spec: { op: "rename_column", table: "tx", from: "note", to: "memo" },
      additive: false,
    },
    {
      name: "rename_table",
      spec: { op: "rename_table", from: "tx", to: "ledger" },
      additive: false,
    },
  ];

  for (const c of cases) {
    it(`classifies ${c.name} additive=${c.additive}`, () => {
      expect(isAdditiveMigration(c.spec)).toBe(c.additive);
    });
  }

  const malformed: Array<{ name: string; spec: unknown }> = [
    { name: "undefined", spec: undefined },
    { name: "null", spec: null },
    { name: "a string", spec: "create_table" },
    { name: "a number", spec: 1 },
    { name: "an array", spec: [{ op: "create_table" }] },
    { name: "an empty object", spec: {} },
    { name: "a non-string op", spec: { op: 3 } },
    { name: "an unknown op", spec: { op: "drop_table", table: "tx" } },
    { name: "a case-mismatched op", spec: { op: "CREATE_TABLE", table: "tx" } },
    { name: "a prototype-key op", spec: { op: "toString" } },
  ];

  for (const c of malformed) {
    it(`treats ${c.name} as not additive`, () => {
      expect(isAdditiveMigration(c.spec)).toBe(false);
    });
  }
});

describe("migrationEscalation", () => {
  it("does not escalate additive ops", () => {
    expect(migrationEscalation({ project: "budget", spec: { op: "create_table" } })).toBe(false);
    expect(migrationEscalation({ project: "budget", spec: { op: "add_column" } })).toBe(false);
    expect(migrationEscalation({ project: "budget", spec: { op: "create_index" } })).toBe(false);
  });

  it("escalates destructive and identity-changing ops", () => {
    expect(migrationEscalation({ project: "budget", spec: { op: "drop_column" } })).toBe(true);
    expect(migrationEscalation({ project: "budget", spec: { op: "rename_column" } })).toBe(true);
    expect(migrationEscalation({ project: "budget", spec: { op: "rename_table" } })).toBe(true);
  });

  it("escalates a missing or unparseable spec", () => {
    expect(migrationEscalation({})).toBe(true);
    expect(migrationEscalation({ project: "budget", spec: "create_table" })).toBe(true);
    expect(migrationEscalation({ project: "budget", spec: { op: "wat" } })).toBe(true);
  });
});
