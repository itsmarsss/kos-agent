import { isReadOnlyQuery } from "@kos/shared";

import type { Db } from "../store/db.js";

/**
 * Read-only display query executor for page widgets. Caps rows and rejects
 * anything that is not a single SELECT/WITH so the UI path cannot write or hang
 * the DB with multi-statement abuse.
 */

export interface DisplayQueryOptions {
  /** Hard row cap (default 500). */
  rowCap?: number;
}

export interface DisplayQueryResult {
  rows: Record<string, unknown>[];
  truncated: boolean;
}

export function runDisplayQuery(
  db: Db,
  sql: string,
  options: DisplayQueryOptions = {},
): DisplayQueryResult {
  if (!isReadOnlyQuery(sql)) {
    throw new Error("display query must be a single read-only SELECT/WITH");
  }
  const rowCap = options.rowCap ?? 500;
  const stmt = db.prepare(sql);
  if (!stmt.reader) {
    throw new Error("display query did not produce a result set");
  }
  // Fetch one extra row to detect truncation without loading unbounded results.
  const rows = stmt.all() as Record<string, unknown>[];
  if (rows.length > rowCap) {
    return { rows: rows.slice(0, rowCap), truncated: true };
  }
  return { rows, truncated: false };
}
