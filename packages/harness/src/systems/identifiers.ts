/**
 * SQL identifier validation and slugging. Project slugs and table/column names
 * are never bound parameters (SQLite can't bind identifiers), so they must be
 * validated to a strict charset before being interpolated into DDL. This is the
 * gate that keeps the guarded migrate primitive injection-safe.
 */

const IDENTIFIER_RE = /^[a-z][a-z0-9_]*$/;
const MAX_IDENTIFIER_LEN = 63;

export function isValidIdentifier(s: string): boolean {
  return s.length > 0 && s.length <= MAX_IDENTIFIER_LEN && IDENTIFIER_RE.test(s);
}

export function assertIdentifier(s: string, what = "identifier"): string {
  if (!isValidIdentifier(s)) {
    throw new Error(
      `invalid ${what}: ${JSON.stringify(s)} (expected ^[a-z][a-z0-9_]*$, <= ${MAX_IDENTIFIER_LEN} chars)`,
    );
  }
  return s;
}

/** Derive a valid base slug from a human name (uniqueness handled by caller). */
export function slugify(name: string): string {
  let s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (s === "") s = "project";
  if (/^[0-9]/.test(s)) s = `p_${s}`;
  return s.slice(0, MAX_IDENTIFIER_LEN).replace(/_+$/g, "");
}

/** Namespaced physical table name for a project table (both validated). */
export function projectTable(slug: string, table: string): string {
  assertIdentifier(slug, "project slug");
  assertIdentifier(table, "table name");
  return `${slug}_${table}`;
}
