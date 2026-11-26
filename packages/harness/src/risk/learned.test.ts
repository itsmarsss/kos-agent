import { describe, expect, it } from "vitest";

import { deletesData, learnable, type LearnedCall } from "./learned.js";
import type { RiskAssessment } from "./tiers.js";

const risky: RiskAssessment = { tier: "risky", escalated: false };

function call(tool: string, input: Record<string, unknown>, over: Partial<LearnedCall> = {}): LearnedCall {
  return { tool, input, assessment: risky, guest: false, secret: false, strict: false, yours: false, ...over };
}

describe("what a learned yes may cover", () => {
  it("covers routine work in the turn's own reach", () => {
    expect(learnable(call("files.edit", { path: "notes/run.mjs" }))).toBe(true);
    expect(learnable(call("sql", { sql: "UPDATE books_items SET done = 1 WHERE id = 3" }))).toBe(true);
    expect(learnable(call("http.fetch", { url: "https://api.ashbyhq.com/x" }))).toBe(true);
    expect(learnable(call("shell.run", { command: "touch notes.md" }))).toBe(true);
    expect(learnable(call("skills.run", { name: "board" }))).toBe(true);
  });

  it("never covers a post where others read, a job's included", () => {
    const beyond = { ...risky, beyondAuto: "messages someone besides you" };
    expect(learnable(call("notify", { to: "discord:channel:42", text: "digest" }, { assessment: beyond }))).toBe(false);
    expect(learnable(call("notify", { to: "discord:user:7", text: "hi" }, { assessment: beyond }))).toBe(false);
  });

  it("never covers a write to KOS's own tables", () => {
    expect(learnable(call("sql", { sql: "UPDATE daemons SET args = '[]'" }, { assessment: { ...risky, neverLearned: true } }))).toBe(false);
  });

  it("never covers what a guest's words started", () => {
    expect(learnable(call("files.edit", { path: "x" }, { guest: true }))).toBe(false);
  });

  it("never covers a secret, the clipboard or what asks every time", () => {
    expect(learnable(call("http.fetch", { url: "https://x" }, { secret: true }))).toBe(false);
    expect(learnable(call("clipboard.read", {}))).toBe(false);
    expect(learnable(call("http.fetch", { url: "https://x" }, { assessment: { ...risky, asksAlways: true } }))).toBe(false);
    expect(learnable(call("browser.eval", { script: "1" }, { strict: true }))).toBe(false);
  });

  it("never covers the owner's own Chrome or a device", () => {
    expect(learnable(call("browser.act", { actions: [] }, { yours: true }))).toBe(false);
    expect(learnable(call("computer.act", {}))).toBe(false);
    expect(learnable(call("computer.start", {}, { assessment: { ...risky, startsSession: true } }))).toBe(false);
  });

  it("never covers a delete of the owner's data", () => {
    expect(learnable(call("files.rm", { path: "projects/books/x.md" }))).toBe(false);
    expect(learnable(call("sql", { sql: "DELETE FROM books_items WHERE id = 1" }))).toBe(false);
    expect(learnable(call("sql", { sql: "DROP TABLE books_items" }))).toBe(false);
    expect(learnable(call("sql", { sql: "UPDATE books_items SET title = ''" }))).toBe(false);
    expect(learnable(call("shell.run", { command: "rm -rf build" }, { assessment: { ...risky, beyondAuto: "deletes recursively" } }))).toBe(false);
  });

  it("never covers money or a change to KOS itself", () => {
    expect(learnable(call("mcp.shop.buy_now", {}, { assessment: { ...risky, beyondAuto: "may spend money" } }))).toBe(false);
    expect(learnable(call("skills.promote", { name: "x" }, { assessment: { ...risky, beyondAuto: "makes a skill part of KOS" } }))).toBe(false);
  });
});

describe("a delete, as it reads one", () => {
  it("knows a delete from an update that names its rows", () => {
    expect(deletesData("sql", { sql: "UPDATE t SET a = 1 WHERE id = 2" })).toBe(false);
    expect(deletesData("sql", { sql: "INSERT INTO t (a) VALUES (1)" })).toBe(false);
    expect(deletesData("sql", { sql: "delete from t" })).toBe(true);
    expect(deletesData("sql", { sql: "TRUNCATE t" })).toBe(true);
    expect(deletesData("files.rm", { path: "a" })).toBe(true);
    expect(deletesData("files.edit", { path: "a" })).toBe(false);
  });

  it("is not fooled by a WHERE in a string or a comment, or one that holds for every row", () => {
    expect(deletesData("sql", { sql: "UPDATE t SET note = 'where it was'" })).toBe(true);
    expect(deletesData("sql", { sql: "UPDATE t SET a = 1 -- WHERE id = 2" })).toBe(true);
    expect(deletesData("sql", { sql: "UPDATE t SET a = 1 /* where id = 2 */" })).toBe(true);
    expect(deletesData("sql", { sql: "UPDATE t SET a = 1 WHERE 1 = 1" })).toBe(true);
    expect(deletesData("sql", { sql: "UPDATE t SET a = 1 WHERE 'x' = 'x'" })).toBe(true);
    expect(deletesData("sql", { sql: "UPDATE t SET a = 1 WHERE TRUE" })).toBe(true);
    expect(deletesData("sql", { sql: "UPDATE t SET a = 1 WHERE id = id" })).toBe(true);
    expect(deletesData("sql", { sql: 'UPDATE t SET a = 1 WHERE "id" = "id"' })).toBe(true);
    expect(deletesData("sql", { sql: "UPDATE t SET a = 1 WHERE id IS NOT NULL" })).toBe(true);
    expect(deletesData("sql", { sql: "UPDATE t SET a = 1 WHERE id = 2 OR 1" })).toBe(true);
    expect(deletesData("sql", { sql: "UPDATE t SET a = 1 WHERE id = 2 RETURNING a" })).toBe(false);
    expect(deletesData("sql", { sql: 'UPDATE t SET a = 1 WHERE "id" = 2' })).toBe(false);
    expect(deletesData("sql", { sql: "UPDATE t SET a = 1 WHERE id = 2 AND done = 0" })).toBe(false);
  });

  it("reads a delete word anywhere in the raw statement, so a quoted name cannot hide one", () => {
    // The probes that once read as no delete: a name in quotes that looks like the start of a comment or a string.
    expect(deletesData("sql", { sql: 'WITH "a--" AS (SELECT 1) DELETE FROM notes WHERE id IN (SELECT 1 FROM "a--")' })).toBe(true);
    expect(deletesData("sql", { sql: 'WITH "a/*" AS (SELECT 1) DELETE FROM notes WHERE id IN (SELECT 1 FROM "a/*")' })).toBe(true);
    expect(deletesData("sql", { sql: "WITH \"a'\" AS (SELECT 1) DELETE FROM notes WHERE id IN (SELECT 1 FROM \"a'\")" })).toBe(true);
    expect(deletesData("sql", { sql: "WITH `a--` AS (SELECT 1) DELETE FROM notes" })).toBe(true);
    expect(deletesData("sql", { sql: "WITH [a--] AS (SELECT 1) DELETE FROM notes" })).toBe(true);
    // A quoted name does not swallow the rest of an UPDATE either.
    expect(deletesData("sql", { sql: 'UPDATE notes SET "a--" = 1' })).toBe(true);
    // The word in a value only asks: the safe side.
    expect(deletesData("sql", { sql: "UPDATE t SET note = 'delete me' WHERE id = 2" })).toBe(true);
  });

  it("counts an update of every row, and a replace, as one", () => {
    expect(deletesData("sql", { sql: "UPDATE t SET a = 1" })).toBe(true);
    expect(deletesData("sql", { sql: "REPLACE INTO t (id, a) VALUES (1, 2)" })).toBe(true);
  });
});
