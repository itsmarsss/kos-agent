import Database from "better-sqlite3";

export type { Database as Db } from "better-sqlite3";

/**
 * Open the workspace SQLite database. WAL mode pairs with the serial work
 * queue for fast single-writer access; foreign keys are enforced so the
 * schema can rely on them.
 */
export function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

/**
 * Open a second, read-only handle on the same workspace database. Display
 * queries run through this so a write is refused by SQLite itself (SQLITE_
 * READONLY) rather than by pattern-matching the SQL, which is defence a
 * cleverly-worded statement can talk its way past.
 *
 * The file must already exist: a read-only handle cannot create it.
 */
export function openReadOnlyDatabase(path: string): Database.Database {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  return db;
}
