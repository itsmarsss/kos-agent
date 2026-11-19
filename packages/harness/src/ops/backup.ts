import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";

import Database from "better-sqlite3";

import type { Db } from "../store/db.js";

const exec = promisify(execFile);

export interface Snapshot {
  sha: string;
  message: string;
  date: string;
}

export interface BackupAuthor {
  name: string;
  email: string;
}

/**
 * Timed git snapshots of the workspace. The workspace has its own git repo,
 * separate from the source tree, so the whole system backs up by committing one
 * folder. Rollback restores files from a snapshot (the DB-file restore the
 * migrate primitive relies on instead of reverse DDL).
 *
 * The database is committed as a copy, never as itself: kos.sqlite is live
 * and in WAL mode, so the file, its -wal and its -shm read at three moments
 * are a torn database. Each snapshot first takes a copy through SQLite's
 * backup API into DB_SNAPSHOT, which is what history holds. A restore checks
 * that copy out; with the host stopped, it replaces kos.sqlite, and the old
 * -wal and -shm are deleted, not kept beside it. The workspace's .kos folder
 * (logs, caches, scratch, the host's own state) is never committed: a restore
 * needs nothing in it.
 */
/** How deep to look for nested repos. Sites live two or three down. */
const SCAN_DEPTH = 5;

/** Marks the block this writes, so anything above it is left alone. */
const MARKER = "# kos: folders with their own git repo";

/**
 * Never in a snapshot, wherever they are: Claude Code's own records (a
 * transcript holds every tool result), left by a build or chat from before
 * they were kept outside the workspace. A project's own .claude settings
 * stay in.
 */
const UNKEPT = ["**/.claude/projects/", "**/.claude/todos/", "**/.claude/statsig/", ".claude.json", "/kos.sqlite", "/kos.sqlite-wal", "/kos.sqlite-shm", "/kos.sqlite-journal", "/kos.snapshot.sqlite.part", "/kos.snapshot.sqlite-wal", "/kos.snapshot.sqlite-shm", "/kos.snapshot.sqlite-journal", "/.kos/"];

/** A tracked path under one of those. */
const UNKEPT_PATH = /(^|\/)(\.claude\/(projects|todos|statsig)\/|\.claude\.json$)|^kos\.sqlite(-wal|-shm|-journal)?$|^kos\.snapshot\.sqlite(\.part|-wal|-shm|-journal)$|^\.kos\//;

/** The database as a snapshot keeps it: a consistent copy, at the workspace's root. */
export const DB_SNAPSHOT = "kos.snapshot.sqlite";

export class WorkspaceBackup {
  constructor(
    private readonly root: string,
    private readonly author: BackupAuthor = { name: "KOS", email: "kos@local" },
    /** The live database, copied into DB_SNAPSHOT before each commit. */
    private readonly db?: Pick<Db, "backup">,
  ) {}

  /** The database copied whole through SQLite's backup API, then moved into place, so a snapshot never holds half of one. */
  private async copyDb(): Promise<void> {
    if (!this.db) return;
    const part = join(this.root, `${DB_SNAPSHOT}.part`);
    rmSync(part, { force: true });
    await this.db.backup(part);
    // Out of WAL mode, so the copy is one file: opened later, it grows no -wal or -shm beside it.
    const copy = new Database(part);
    try {
      copy.pragma("journal_mode = DELETE");
    } finally {
      copy.close();
    }
    renameSync(part, join(this.root, DB_SNAPSHOT));
  }

  private git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return exec("git", args, { cwd: this.root });
  }

  /** Initialize the workspace git repo if it does not exist yet. */
  async ensureRepo(): Promise<void> {
    if (!existsSync(join(this.root, ".git"))) {
      await this.git(["init", "-q"]);
    }
  }

  /**
   * Folders inside the workspace that carry their own git repo.
   *
   * builds.run points Claude Code at a site folder, and one of the first
   * things it does there is `git init`. Git will not add such a folder as
   * ordinary files: with commits it becomes a gitlink, and without any it
   * fails outright with "does not have a commit checked out", which took the
   * whole snapshot down with it.
   */
  private nestedRepos(): string[] {
    const found: string[] = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > SCAN_DEPTH) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === "node_modules") continue;
        const full = join(dir, entry.name);
        if (entry.name === ".git") continue;
        if (existsSync(join(full, ".git"))) {
          // Its own repo, so its own history covers it. Not descended into:
          // repos inside repos are that repo's problem.
          found.push(relative(this.root, full).split(sep).join("/"));
          continue;
        }
        walk(full, depth + 1);
      }
    };
    walk(this.root, 0);
    return found.sort();
  }

  /**
   * Keep nested repos out of the way of `git add -A`.
   *
   * Written to .git/info/exclude rather than .gitignore because it is this
   * machine's mechanical detail, not a fact about the workspace, and a
   * .gitignore in the workspace root is the owner's to write.
   */
  private syncExcludes(): string[] {
    const nested = this.nestedRepos();
    const path = join(this.root, ".git", "info", "exclude");
    const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
    const kept = existing
      .split("\n")
      .slice(
        0,
        existing.includes(MARKER)
          ? existing.split("\n").indexOf(MARKER)
          : undefined,
      )
      .join("\n")
      .replace(/\n+$/, "");
    const block = [MARKER, ...nested.map((p) => `/${p}/`), ...UNKEPT].join("\n");
    const next = `${kept ? `${kept}\n` : ""}${block}\n`;
    if (next !== existing) writeFileSync(path, next);
    return nested;
  }

  /**
   * Take out of the index what an older snapshot committed before it was
   * excluded: an exclude only stops new files, and a tracked transcript would
   * go on being committed. The files stay on disk; history keeps old copies.
   */
  private async untrackUnkept(): Promise<void> {
    const { stdout } = await this.git(["ls-files"]);
    const unkept = stdout.split("\n").filter((path) => UNKEPT_PATH.test(path));
    if (unkept.length > 0) await this.git(["rm", "-r", "-q", "--cached", "--", ...unkept]);
  }

  /** Folders the backup is deliberately not covering, and why it is not. */
  async excluded(): Promise<string[]> {
    return this.nestedRepos();
  }

  /** Files the snapshot actually covers. */
  async tracked(): Promise<string[]> {
    const { stdout } = await this.git(["ls-files"]);
    return stdout.trim().split("\n").filter(Boolean);
  }

  /** Commit the current workspace state. Returns the sha, or null if unchanged. */
  async snapshot(message?: string): Promise<string | null> {
    const msg = message ?? `snapshot ${new Date().toISOString()}`;
    // Before add, because a folder that gained its own repo since the last
    // snapshot is exactly the case that used to break this.
    this.syncExcludes();
    await this.copyDb();
    await this.untrackUnkept();
    await this.git(["add", "-A"]);
    const { stdout: status } = await this.git(["status", "--porcelain"]);
    if (status.trim() === "") return null;
    await this.git([
      "-c",
      `user.name=${this.author.name}`,
      "-c",
      `user.email=${this.author.email}`,
      "commit",
      "-q",
      "-m",
      msg,
    ]);
    const { stdout } = await this.git(["rev-parse", "HEAD"]);
    return stdout.trim();
  }

  async list(limit = 20): Promise<Snapshot[]> {
    const { stdout } = await this.git([
      "log",
      `-${limit}`,
      "--pretty=%H%x09%s%x09%cI",
    ]);
    return stdout
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((line) => {
        const [sha, message, date] = line.split("\t");
        return { sha: sha ?? "", message: message ?? "", date: date ?? "" };
      });
  }

  /** Restore tracked files from a snapshot into the working tree: the database as DB_SNAPSHOT, for a stopped host to put in place. */
  async restore(sha: string): Promise<void> {
    await this.git(["checkout", sha, "--", "."]);
  }
}
