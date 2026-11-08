import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { resolvePath } from "../jail/resolvePath.js";
import { openDatabase, openReadOnlyDatabase, type Db } from "./db.js";

/** The single SQLite file at the workspace root. */
export const DB_FILENAME = "kos.sqlite";

/**
 * A KOS workspace: one directory that holds everything (the SQLite DB and all
 * project files). The agent lives entirely inside it. Every path the agent
 * touches goes through `resolve`, the jail gate, so nothing escapes.
 */
export class Workspace {
  /** Absolute, real (symlink-free) workspace root. */
  readonly root: string;
  readonly db: Db;

  /** Opened on first use; display queries never need it until a page renders. */
  private readerDb?: Db;

  private constructor(root: string, db: Db) {
    this.root = root;
    this.db = db;
  }

  /**
   * A read-only handle on the same database, for rendering agent-authored
   * page specs. Separate from `db` so the UI read path physically cannot
   * write, whatever the spec's query says.
   */
  get reader(): Db {
    if (!this.readerDb) {
      this.readerDb = openReadOnlyDatabase(resolvePath(this.root, DB_FILENAME));
    }
    return this.readerDb;
  }

  /**
   * Open (creating if needed) the workspace at `rootDir` and its database.
   * The root is realpath-resolved once here so the jail gate has a stable,
   * symlink-free base to check containment against.
   */
  static open(rootDir: string): Workspace {
    const abs = resolve(rootDir);
    mkdirSync(abs, { recursive: true });
    const root = realpathSync(abs);
    const db = openDatabase(resolvePath(root, DB_FILENAME));
    return new Workspace(root, db);
  }

  /** Resolve a workspace-relative path through the jail gate. */
  resolve(requestPath: string): string {
    return resolvePath(this.root, requestPath);
  }

  close(): void {
    this.readerDb?.close();
    this.readerDb = undefined;
    this.db.close();
  }
}

/**
 * A workspace-relative path as a fence compares it: normalized, in the case
 * it has on disk as far as it exists, and folded to lower case throughout.
 * The workspace can sit on a case-insensitive disk, where `Blobs/x` opens
 * `blobs/x`, so a fence that matched names exactly could be walked round by
 * a change of case. Folding the whole path refuses that on any disk; the
 * on-disk case is read too, so a path through a link inside the workspace
 * is compared where it lands. Outside the workspace it is returned folded
 * as given, for the jail to refuse.
 */
export function foldedPath(root: string, path: string): string {
  const rel = relative(root, resolve(root, path.replace(/\\/g, "/")));
  const parts = rel.split(sep).filter((p) => p !== "" && p !== ".");
  if (rel.startsWith("..") || isAbsolute(rel)) return parts.join("/").toLowerCase();
  for (let n = parts.length; n > 0; n--) {
    const at = join(root, ...parts.slice(0, n));
    if (!existsSync(at)) continue;
    try {
      const real = relative(realpathSync.native(root), realpathSync.native(at));
      if (!real.startsWith("..") && !isAbsolute(real)) return [...real.split(sep).filter((p) => p !== ""), ...parts.slice(n)].join("/").toLowerCase();
    } catch {
      // Gone between the check and the read: compared as given.
    }
    break;
  }
  return parts.join("/").toLowerCase();
}
