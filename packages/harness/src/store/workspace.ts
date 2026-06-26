import { mkdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

import { resolvePath } from "../jail/resolvePath.js";
import { openDatabase, type Db } from "./db.js";

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

  private constructor(root: string, db: Db) {
    this.root = root;
    this.db = db;
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
    this.db.close();
  }
}
