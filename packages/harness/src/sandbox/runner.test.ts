import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JailError } from "../jail/resolvePath.js";
import { Workspace } from "../store/workspace.js";
import { runSandbox } from "./runner.js";

describe("runSandbox", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-sbx-"));
    Workspace.open(root).close(); // creates kos.sqlite to snapshot
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function script(name: string, body: string): string {
    writeFileSync(join(root, name), body);
    return name;
  }

  it("runs a script with dry-run env and a copied DB path", async () => {
    const entry = script(
      "ok.mjs",
      `console.log("DRY=" + process.env.KOS_DRY_RUN);
       console.log("DB=" + process.env.KOS_DB);
       process.exit(0);`,
    );
    const res = await runSandbox({ workspaceRoot: root, entry });
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("DRY=1");
    expect(res.stdout).toContain("kos.sqlite");
  });

  it("reports a non-zero exit as not ok", async () => {
    const entry = script("fail.mjs", `process.exit(3);`);
    const res = await runSandbox({ workspaceRoot: root, entry });
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(3);
  });

  it("kills and flags a script that exceeds the timeout", async () => {
    const entry = script("hang.mjs", `setTimeout(() => {}, 100000);`);
    const res = await runSandbox({
      workspaceRoot: root,
      entry,
      timeoutMs: 400,
    });
    expect(res.timedOut).toBe(true);
    expect(res.ok).toBe(false);
  });

  it("rejects an entry that escapes the workspace", async () => {
    await expect(
      runSandbox({ workspaceRoot: root, entry: "../escape.mjs" }),
    ).rejects.toThrow(JailError);
  });
});
