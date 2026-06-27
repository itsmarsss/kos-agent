import type { MutationTarget } from "@kos/shared";

import type { Db } from "../store/db.js";
import { assertIdentifier } from "../systems/identifiers.js";

/**
 * The guarded mutation path for write-capable widgets. A widget declares a
 * MutationTarget (table + editable columns + allowed ops); an edit becomes a
 * validated, parameterized statement against that table only. A widget can
 * never run arbitrary or destructive SQL, mutate a column it did not declare,
 * or touch a different table.
 */

export type WidgetEdit =
  | { op: "insert"; values: Record<string, unknown> }
  | {
      op: "update";
      key: { column: string; value: unknown };
      values: Record<string, unknown>;
    }
  | { op: "delete"; key: { column: string; value: unknown } };

export interface MutationResult {
  changes: number;
  lastInsertRowid?: number;
}

function assertAllowed(target: MutationTarget, op: WidgetEdit["op"]): void {
  const allow = target.allow ?? ["insert", "update"];
  if (!allow.includes(op)) {
    throw new Error(`op not allowed for this widget: ${op}`);
  }
}

function assertColumns(target: MutationTarget, values: Record<string, unknown>): string[] {
  const declared = new Set(target.columns);
  const cols = Object.keys(values);
  if (cols.length === 0) throw new Error("no values provided");
  for (const c of cols) {
    if (!declared.has(c)) {
      throw new Error(`column not editable by this widget: ${c}`);
    }
    assertIdentifier(c, "column");
  }
  return cols;
}

/** Validate and execute one widget edit against its declared target. */
export function executeMutation(
  db: Db,
  target: MutationTarget,
  edit: WidgetEdit,
): MutationResult {
  const table = assertIdentifier(target.table, "table");
  assertAllowed(target, edit.op);

  if (edit.op === "insert") {
    const cols = assertColumns(target, edit.values);
    const placeholders = cols.map(() => "?").join(", ");
    const info = db
      .prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`)
      .run(...cols.map((c) => edit.values[c]));
    return { changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) };
  }

  if (edit.op === "update") {
    const cols = assertColumns(target, edit.values);
    const keyCol = assertIdentifier(edit.key.column, "key column");
    const set = cols.map((c) => `${c} = ?`).join(", ");
    const info = db
      .prepare(`UPDATE ${table} SET ${set} WHERE ${keyCol} = ?`)
      .run(...cols.map((c) => edit.values[c]), edit.key.value);
    return { changes: info.changes };
  }

  // delete
  const keyCol = assertIdentifier(edit.key.column, "key column");
  const info = db
    .prepare(`DELETE FROM ${table} WHERE ${keyCol} = ?`)
    .run(edit.key.value);
  return { changes: info.changes };
}
