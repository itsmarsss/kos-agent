import type { Db } from "../store/db.js";

/**
 * Per-instance configuration: the personalization layer that lives in the
 * workspace, not in module code. Settings like currency, categories, limits, or
 * a target channel are config rows keyed by project slug, editable without
 * touching (and forking off) the shared module code. Values are JSON so any
 * shape round-trips.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS instance_config (
  project_slug TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  PRIMARY KEY (project_slug, key)
);
`;

export class InstanceConfig {
  constructor(private readonly db: Db) {
    this.db.exec(SCHEMA);
  }

  set(slug: string, key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO instance_config (project_slug, key, value_json)
         VALUES (?, ?, ?)
         ON CONFLICT (project_slug, key) DO UPDATE SET value_json = excluded.value_json`,
      )
      .run(slug, key, JSON.stringify(value));
  }

  get<T = unknown>(slug: string, key: string): T | undefined {
    const row = this.db
      .prepare(
        `SELECT value_json FROM instance_config WHERE project_slug = ? AND key = ?`,
      )
      .get(slug, key) as { value_json: string } | undefined;
    return row ? (JSON.parse(row.value_json) as T) : undefined;
  }

  /** All config for an instance as a plain object. */
  all(slug: string): Record<string, unknown> {
    const rows = this.db
      .prepare(
        `SELECT key, value_json FROM instance_config WHERE project_slug = ?`,
      )
      .all(slug) as { key: string; value_json: string }[];
    const out: Record<string, unknown> = {};
    for (const r of rows) out[r.key] = JSON.parse(r.value_json);
    return out;
  }

  delete(slug: string, key: string): boolean {
    return (
      this.db
        .prepare(
          `DELETE FROM instance_config WHERE project_slug = ? AND key = ?`,
        )
        .run(slug, key).changes > 0
    );
  }
}
