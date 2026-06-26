import { describe, expect, it } from "vitest";

import {
  domainAllowlistEscalation,
  isSqlWrite,
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
