import Database from "better-sqlite3";

/**
 * Copy a SQLite database to a new file via the backup API, producing a
 * consistent snapshot (including WAL contents) without mutating the source. The
 * sandbox runs agent-written skills against this throwaway copy, never the live
 * workspace DB.
 */
export async function snapshotDatabase(
  srcPath: string,
  destPath: string,
): Promise<void> {
  const db = new Database(srcPath, { readonly: true });
  try {
    await db.backup(destPath);
  } finally {
    db.close();
  }
}
