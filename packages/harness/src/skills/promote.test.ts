import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApprovalQueue } from "../ops/approvals.js";
import { WorkspaceBackup } from "../ops/backup.js";
import type { SandboxResult } from "../sandbox/runner.js";
import { Workspace } from "../store/workspace.js";
import { SkillPromoter } from "./promote.js";

const PASS: SandboxResult = {
  ok: true,
  exitCode: 0,
  signal: null,
  stdout: "",
  stderr: "",
  timedOut: false,
};
const FAIL: SandboxResult = { ...PASS, ok: false, exitCode: 1, stderr: "boom" };
const TIMEOUT: SandboxResult = { ...PASS, ok: false, exitCode: null, timedOut: true };

describe("SkillPromoter", () => {
  let root: string;
  let ws: Workspace;
  let approvals: ApprovalQueue;
  let backup: WorkspaceBackup;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-promote-"));
    ws = Workspace.open(root);
    approvals = new ApprovalQueue(ws.db);
    backup = new WorkspaceBackup(ws.root);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  function promoter(result: SandboxResult): SkillPromoter {
    return new SkillPromoter({
      workspaceRoot: ws.root,
      backup,
      approvals,
      runSandbox: async () => result,
    });
  }

  it("auto-commits a safe skill that passes the sandbox", async () => {
    const out = await promoter(PASS).promote({ entry: "skills/hello.mjs" });
    expect(out.status).toBe("promoted");
    if (out.status === "promoted") expect(out.sha).toBeTruthy();
    expect(approvals.pending()).toHaveLength(0);
  });

  it("queues a risky skill for approval even when it passes", async () => {
    const out = await promoter(PASS).promote({
      entry: "skills/risky.mjs",
      risky: true,
    });
    expect(out.status).toBe("pending_approval");
    expect(approvals.pending()).toHaveLength(1);
  });

  it("rejects a skill that fails the sandbox", async () => {
    const out = await promoter(FAIL).promote({ entry: "skills/bad.mjs" });
    expect(out).toEqual({ status: "rejected", reason: "boom" });
  });

  it("rejects a skill that times out", async () => {
    const out = await promoter(TIMEOUT).promote({ entry: "skills/hang.mjs" });
    expect(out).toEqual({ status: "rejected", reason: "sandbox timed out" });
  });
});
