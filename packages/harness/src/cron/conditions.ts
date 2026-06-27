import type { Db } from "../store/db.js";

/**
 * Query scope and condition evaluation for cron jobs. A job's named query
 * produces a single result row; that row is the variable scope for both the
 * condition test and {var} templating. Fact conditions are deterministic SQL,
 * which is cheap and which the LLM already speaks.
 *
 * Note: query and test are owner/agent-authored stored data, gated by the
 * approval queue at creation, not free user input at run time.
 */

/** Run the named query and return its first row as the variable scope. */
export function queryScope(
  db: Db,
  query: string | null,
): Record<string, unknown> {
  if (!query) return {};
  const row = db.prepare(query).get() as Record<string, unknown> | undefined;
  return row ?? {};
}

/**
 * Evaluate a boolean SQL test expression over the query scope. With a query,
 * the test runs against its columns; without one, it is a standalone boolean.
 * A missing test means "always run".
 */
export function evaluateCondition(
  db: Db,
  test: string | null,
  query: string | null,
): boolean {
  if (!test) return true;
  const sql = query
    ? `SELECT (${test}) AS pass FROM (${query})`
    : `SELECT (${test}) AS pass`;
  const row = db.prepare(sql).get() as { pass: unknown } | undefined;
  return Boolean(row && row.pass);
}
