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
