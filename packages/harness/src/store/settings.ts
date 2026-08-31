import type { Db } from "./db.js";

/**
 * Owner settings that outlive a process: small, typed, and read at boot.
 *
 * Kept as JSON under a key rather than a column per setting, because these are
 * preferences the owner edits, not data anything joins against.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export class SettingsStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    this.db.exec(SCHEMA);
  }

  get<T>(key: string): T | undefined {
    const row = this.db
      .prepare(`SELECT value FROM settings WHERE key = ?`)
      .get(key) as { value: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      // A value we cannot parse is a value we cannot honour; treat it as unset
      // rather than throwing on every boot.
      return undefined;
    }
  }

  set<T>(key: string, value: T): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), this.now());
  }

  delete(key: string): boolean {
    return this.db.prepare(`DELETE FROM settings WHERE key = ?`).run(key).changes > 0;
  }
}
