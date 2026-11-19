import { isReadOnlyQuery } from "@kos/shared";

import type { Db } from "../store/db.js";

/**
 * Query scope and condition evaluation for cron jobs. A job's named query
 * produces a single result row; that row is the variable scope for both the
 * condition test and {var} templating. Fact conditions are deterministic SQL,
 * which is cheap and which the LLM already speaks.
 *
 * Query and test are model-written stored data, run unattended long after
 * they were written, so every statement either makes is a single read and
 * passes the job's check (the kernel's: the sql tool's fence, for the
 * job's own project) before it runs. A test is spliced into a statement,
 * so it is the statement as spliced that is judged.
 */

/** Runs one statement of a job's and gives back its first row. */
export type ScopeReader = (sql: string) => Record<string, unknown> | undefined;

/**
 * A reader over `db` that runs a statement only when it is one read and
 * `check`, when given, lets it through; `check` throws to refuse.
 */
export function readerOf(db: Db, check?: (sql: string) => void): ScopeReader {
  return (sql) => {
    if (!isReadOnlyQuery(sql)) throw new Error("a job's query and condition are reads: one SELECT or WITH, nothing else");
    check?.(sql);
    return db.prepare(sql).get() as Record<string, unknown> | undefined;
  };
}

/** The statement a condition runs as: the test over the query's row, or standing alone. */
export function conditionSql(test: string, query: string | null): string {
  return query ? `SELECT (${test}) AS pass FROM (${query})` : `SELECT (${test}) AS pass`;
}

/** Run the named query and return its first row as the variable scope. */
export function queryScope(read: ScopeReader, query: string | null): Record<string, unknown> {
  if (!query) return {};
  return read(query) ?? {};
}

/**
 * Evaluate a boolean SQL test expression over the query scope. With a query,
 * the test runs against its columns; without one, it is a standalone boolean.
 * A missing test means "always run".
 */
export function evaluateCondition(read: ScopeReader, test: string | null, query: string | null): boolean {
  if (!test) return true;
  const row = read(conditionSql(test, query));
  return Boolean(row && row["pass"]);
}
