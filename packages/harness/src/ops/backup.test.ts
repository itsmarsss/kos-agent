import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import Database from "better-sqlite3";

import { Workspace } from "../store/workspace.js";
import { BACKUP_GIT_DIR, DB_SNAPSHOT, WorkspaceBackup } from "./backup.js";

/** git on the workspace's backup repo, as a test reaches it by hand. */
const backupGit = (root: string, args: string[]): string => execFileSync("git", [`--git-dir=${join(root, BACKUP_GIT_DIR)}`, `--work-tree=${root}`, ...args], { cwd: root }).toString();

describe("WorkspaceBackup", () => {
  let root: string;
  let backup: WorkspaceBackup;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-backup-"));
    backup = new WorkspaceBackup(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("snapshots, lists, and restores workspace state", async () => {
    await backup.ensureRepo();
    const file = join(root, "data.txt");

    writeFileSync(file, "v1");
    const s1 = await backup.snapshot("first");
    expect(s1).toBeTruthy();

    writeFileSync(file, "v2");
    const s2 = await backup.snapshot("second");
    expect(s2).toBeTruthy();

    expect(await backup.list()).toHaveLength(2);

    await backup.restore(s1!);
    expect(readFileSync(file, "utf8")).toBe("v1");
  });

  it("never snapshots Claude Code's own records, wherever a build left them, and keeps a project's .claude settings", async () => {
    await backup.ensureRepo();
    const put = (path: string, body = "{}"): void => {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), body);
    };
    put("sites/app/index.html", "<p>hi</p>");
    put("sites/app/.claude/settings.json");
    // Committed before the exclude existed: taken out of the index, left on disk.
    put("sites/old/.claude/projects/t.jsonl");
    backupGit(root, ["add", "-f", "sites/old/.claude/projects/t.jsonl"]);
    for (const path of [".claude/projects/t.jsonl", "sites/app/.claude/projects/t.jsonl", "sites/app/.claude/todos/t.json", "sites/app/.claude/statsig/s", "sites/app/.claude.json"]) put(path);
    await backup.snapshot("with a build");
    expect(await backup.tracked()).toEqual(["sites/app/.claude/settings.json", "sites/app/index.html"]);
    expect(readFileSync(join(root, "sites/old/.claude/projects/t.jsonl"), "utf8")).toBe("{}");
  });

  it("commits a consistent copy of the database, never the live file, its WAL or the workspace's .kos", async () => {
    const ws = Workspace.open(root);
    try {
      const withDb = new WorkspaceBackup(root, undefined, ws.db);
      await withDb.ensureRepo();
      ws.db.exec("CREATE TABLE notes (body TEXT)");
      // Committed by an older snapshot: taken out of the index, left on disk.
      backupGit(root, ["add", "-f", "kos.sqlite"]);
      // In the WAL, not yet checkpointed into kos.sqlite: a copy of the file alone would lose it.
      ws.db.pragma("wal_autocheckpoint = 0");
      ws.db.prepare("INSERT INTO notes (body) VALUES (?)").run("only in the wal");
      mkdirSync(join(root, ".kos", "tmp"), { recursive: true });
      writeFileSync(join(root, ".kos", "daemon.log"), "raw host output");
      writeFileSync(join(root, ".kos", "tmp", "x"), "scratch");
      writeFileSync(join(root, "profile.json"), "{}");
      expect(await withDb.snapshot("with a db")).toBeTruthy();
      expect(await withDb.tracked()).toEqual([DB_SNAPSHOT, "profile.json"]);
      const copy = new Database(join(root, DB_SNAPSHOT), { readonly: true });
      expect(copy.prepare("SELECT body FROM notes").all()).toEqual([{ body: "only in the wal" }]);
      copy.close();
      // Nothing changed, nothing committed: the copy is the same bytes, and opening it left nothing beside it.
      expect(await withDb.snapshot("again")).toBeNull();
    } finally {
      ws.close();
    }
  });

  it("keeps its repo under .kos, and moves one an older KOS kept at the root there, history and all", async () => {
    // An older KOS's repo, at the root.
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "notes.md"), "v1");
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-q", "-m", "old"], { cwd: root });
    await backup.ensureRepo();
    expect(existsSync(join(root, ".git"))).toBe(false);
    expect(existsSync(join(root, BACKUP_GIT_DIR, "HEAD"))).toBe(true);
    writeFileSync(join(root, "notes.md"), "v2");
    expect(await backup.snapshot("after the move")).toBeTruthy();
    expect((await backup.list()).map((s) => s.message)).toEqual(["after the move", "old"]);
    expect(await backup.tracked()).toEqual(["notes.md"]);
    // Outside the backup's own calls, the workspace is no repository: a chat's git in a project writes nothing into it.
    mkdirSync(join(root, "projects", "a"), { recursive: true });
    expect(() => execFileSync("git", ["rev-parse", "--git-dir"], { cwd: join(root, "projects", "a"), stdio: "pipe", env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(root) } })).toThrow();
  });

  it("makes a new repo under .kos, with nothing at the root", async () => {
    await backup.ensureRepo();
    expect(existsSync(join(root, ".git"))).toBe(false);
    writeFileSync(join(root, "a.txt"), "a");
    expect(await backup.snapshot("first")).toBeTruthy();
    expect(backupGit(root, ["config", "core.worktree"]).trim()).toBe(root);
  });

  it("returns null when there is nothing to commit", async () => {
    await backup.ensureRepo();
    writeFileSync(join(root, "x.txt"), "a");
    await backup.snapshot("init");
    expect(await backup.snapshot("noop")).toBeNull();
  });
});

/**
 * A folder inside the workspace with its own git repo.
 *
 * This is not hypothetical: builds.run points Claude Code at a site folder and
 * one of the first things it does is `git init`. The backup then failed on
 * every scheduled run with "does not have a commit checked out", which meant
 * the safety net for the entire workspace was off and nothing said so.
 */
describe("WorkspaceBackup with a nested repo", () => {
  let root: string;
  let backup: WorkspaceBackup;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-nested-"));
    backup = new WorkspaceBackup(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function nestedRepo(rel: string, commit: boolean): string {
    const dir = join(root, rel);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), "<h1>site</h1>");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    if (commit) {
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=T",
          "-c",
          "user.email=t@t",
          "commit",
          "-q",
          "-m",
          "init",
        ],
        { cwd: dir },
      );
    }
    return dir;
  }

  it("still backs the workspace up when a site has its own empty repo", async () => {
    await backup.ensureRepo();
    writeFileSync(join(root, "notes.md"), "keep me");
    nestedRepo("projects/site", false);

    const sha = await backup.snapshot("with nested");

    expect(sha).toBeTruthy();
    const files = await backup.tracked();
    expect(files).toContain("notes.md");
  });

  it("does the same when the nested repo has commits", async () => {
    await backup.ensureRepo();
    writeFileSync(join(root, "notes.md"), "keep me");
    nestedRepo("projects/site", true);

    expect(await backup.snapshot("with nested")).toBeTruthy();
    // Committed as a gitlink, the site's own files are not in the backup at
    // all, so it is excluded and its own history is what covers it.
    const files = await backup.tracked();
    expect(files.some((f) => f.startsWith("projects/site"))).toBe(false);
  });

  it("keeps working on the next snapshot too", async () => {
    await backup.ensureRepo();
    nestedRepo("projects/site", false);
    writeFileSync(join(root, "a.md"), "one");
    await backup.snapshot("first");

    writeFileSync(join(root, "b.md"), "two");
    expect(await backup.snapshot("second")).toBeTruthy();
  });

  it("says which folders it is not covering", async () => {
    await backup.ensureRepo();
    nestedRepo("projects/site", false);
    await backup.snapshot("first");
    expect(await backup.excluded()).toEqual(["projects/site"]);
  });
});
