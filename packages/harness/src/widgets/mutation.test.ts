import type { MutationTarget } from "@kos/shared";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { executeMutation } from "./mutation.js";

describe("executeMutation", () => {
  let root: string;
  let ws: Workspace;
  const target: MutationTarget = {
    table: "budget_tx",
    columns: ["amount", "note"],
    allow: ["insert", "update", "delete"],
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-mut-"));
    ws = Workspace.open(root);
    ws.db.exec(
      "CREATE TABLE budget_tx (id INTEGER PRIMARY KEY, amount REAL, note TEXT, secret TEXT)",
    );
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("inserts declared columns via parameters", () => {
    const res = executeMutation(ws.db, target, {
      op: "insert",
      values: { amount: 40, note: "lunch" },
    });
    expect(res.changes).toBe(1);
    const row = ws.db.prepare("SELECT amount, note FROM budget_tx").get();
    expect(row).toEqual({ amount: 40, note: "lunch" });
  });

  it("updates by key column", () => {
    const id = executeMutation(ws.db, target, {
      op: "insert",
      values: { amount: 1, note: "a" },
    }).lastInsertRowid!;
    executeMutation(ws.db, target, {
      op: "update",
      key: { column: "id", value: id },
      values: { amount: 99 },
    });
    expect(
      (ws.db.prepare("SELECT amount FROM budget_tx WHERE id = ?").get(id) as { amount: number }).amount,
    ).toBe(99);
  });

  it("deletes by key column", () => {
    const id = executeMutation(ws.db, target, {
      op: "insert",
      values: { amount: 1, note: "a" },
    }).lastInsertRowid!;
    expect(
      executeMutation(ws.db, target, { op: "delete", key: { column: "id", value: id } })
        .changes,
    ).toBe(1);
  });

  it("rejects a column the widget did not declare", () => {
    expect(() =>
      executeMutation(ws.db, target, {
        op: "insert",
        values: { amount: 1, secret: "x" },
      }),
    ).toThrow(/not editable/);
  });

  it("rejects an op the widget did not allow", () => {
    const noDelete: MutationTarget = { table: "budget_tx", columns: ["amount"] };
    expect(() =>
      executeMutation(ws.db, noDelete, { op: "delete", key: { column: "id", value: 1 } }),
    ).toThrow(/op not allowed/);
  });

  it("rejects an injection-shaped table or key column", () => {
    expect(() =>
      executeMutation(ws.db, { table: "x; DROP TABLE budget_tx", columns: ["amount"] }, {
        op: "insert",
        values: { amount: 1 },
      }),
    ).toThrow(/invalid/);
    expect(() =>
      executeMutation(ws.db, target, {
        op: "delete",
        key: { column: "id = 1 OR 1", value: 1 },
      }),
    ).toThrow(/invalid/);
  });
});
