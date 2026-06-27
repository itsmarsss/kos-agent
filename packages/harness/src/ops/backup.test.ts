import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
