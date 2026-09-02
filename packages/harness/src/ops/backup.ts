import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";

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
 */
/** How deep to look for nested repos. Sites live two or three down. */
const SCAN_DEPTH = 5;

/** Marks the block this writes, so anything above it is left alone. */
const MARKER = "# kos: folders with their own git repo";

export class WorkspaceBackup {
  constructor(
    private readonly root: string,
    private readonly author: BackupAuthor = { name: "KOS", email: "kos@local" },
  ) {}

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
    const block = [MARKER, ...nested.map((p) => `/${p}/`)].join("\n");
    const next = `${kept ? `${kept}\n` : ""}${block}\n`;
    if (next !== existing) writeFileSync(path, next);
    return nested;
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

  /** Restore tracked files from a snapshot into the working tree. */
  async restore(sha: string): Promise<void> {
    await this.git(["checkout", sha, "--", "."]);
  }
}
