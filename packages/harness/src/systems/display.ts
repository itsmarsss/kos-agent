import { isReadOnlyQuery } from "@kos/shared";

import type { Db } from "../store/db.js";

/**
 * Read-only display query executor for page widgets.
 *
 * Three independent bounds, because a page spec is agent-authored and a bad
 * query must degrade to a broken widget, never a broken workspace:
 *
 *  - it runs on a read-only connection, so SQLite itself refuses a write;
 *  - `isReadOnlyQuery` still rejects non-SELECT and stacked statements up
 *    front, which also keeps the error legible instead of a driver code;
 *  - rows are pulled one at a time and stopped at the cap or the deadline,
 *    so a cartesian join cannot materialize into memory.
 *
 * Known limit: better-sqlite3 exposes no sqlite3_interrupt, so a query that
 * blocks before yielding its first row (a large sort or aggregate) cannot be
 * preempted. The deadline bounds row production, not planning.
 */

export interface DisplayQueryOptions {
  /** Hard row cap (default 500). */
  rowCap?: number;
  /** Stop pulling rows after this long (default 2000ms). */
  timeoutMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface DisplayQueryResult {
  rows: Record<string, unknown>[];
  truncated: boolean;
  /** True when the deadline stopped the read before the cap did. */
  timedOut?: boolean;
}

const DEFAULT_ROW_CAP = 500;
const DEFAULT_TIMEOUT_MS = 2000;

export function runDisplayQuery(
  db: Db,
  sql: string,
  options: DisplayQueryOptions = {},
): DisplayQueryResult {
  if (!isReadOnlyQuery(sql)) {
    throw new Error("display query must be a single read-only SELECT/WITH");
  }
  const rowCap = options.rowCap ?? DEFAULT_ROW_CAP;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  const stmt = db.prepare(sql);
  if (!stmt.reader) {
    throw new Error("display query did not produce a result set");
  }

  const deadline = now() + timeoutMs;
  const rows: Record<string, unknown>[] = [];
  let truncated = false;
  let timedOut = false;

  const cursor = stmt.iterate();
  try {
    for (const row of cursor) {
      if (now() > deadline) {
        timedOut = true;
        truncated = true;
        break;
      }
      if (rows.length >= rowCap) {
        truncated = true;
        break;
      }
      rows.push(row as Record<string, unknown>);
    }
  } finally {
    // Release the statement immediately; an abandoned cursor holds a read txn.
    cursor.return?.();
  }

  return { rows, truncated, ...(timedOut ? { timedOut } : {}) };
}
