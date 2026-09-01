import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkspaceBackup } from "./backup.js";

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
