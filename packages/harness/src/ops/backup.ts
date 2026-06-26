import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
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

  /** Commit the current workspace state. Returns the sha, or null if unchanged. */
  async snapshot(message?: string): Promise<string | null> {
    const msg = message ?? `snapshot ${new Date().toISOString()}`;
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
