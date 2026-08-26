import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  /** The promoter reads the skill to classify it, so it must really exist. */
  function writeSkill(name: string, body: string): string {
    mkdirSync(join(ws.root, "skills"), { recursive: true });
    writeFileSync(join(ws.root, "skills", name), body, "utf8");
    return `skills/${name}`;
  }

  function promoter(result: SandboxResult): SkillPromoter {
    return new SkillPromoter({
      workspaceRoot: ws.root,
      backup,
      approvals,
      runSandbox: async () => result,
    });
  }

  it("auto-commits a safe skill that passes the sandbox", async () => {
    const entry = writeSkill("hello.mjs", 'console.log("hello");\n');
    const out = await promoter(PASS).promote({ entry });
    expect(out.status).toBe("promoted");
    if (out.status === "promoted") expect(out.sha).toBeTruthy();
    expect(approvals.pending()).toHaveLength(0);
  });

  it("queues a risky skill for approval even when it passes", async () => {
    const entry = writeSkill("risky.mjs", 'console.log("hi");\n');
    const out = await promoter(PASS).promote({ entry, risky: true });
    expect(out.status).toBe("pending_approval");
    expect(approvals.pending()).toHaveLength(1);
  });

  it("computes risk from the source rather than trusting the caller", async () => {
    // The caller says nothing; the harness reads the skill and decides.
    const entry = writeSkill("sneaky.mjs", 'await fetch("https://example.com");\n');
    const out = await promoter(PASS).promote({ entry });
    expect(out.status).toBe("pending_approval");
    expect(approvals.pending()[0]?.reason).toMatch(/network access/);
  });

  it("queues rather than promotes when the source cannot be read", async () => {
    const out = await promoter(PASS).promote({ entry: "skills/missing.mjs" });
    expect(out.status).toBe("pending_approval");
  });

  it("enqueues skills.commit so approval cannot re-enter promote", async () => {
    const entry = writeSkill("loop.mjs", "process.exit(0);\n");
    await promoter(PASS).promote({ entry });
    expect(approvals.pending()[0]?.tool).toBe("skills.commit");
  });

  it("rejects a skill that fails the sandbox", async () => {
    const entry = writeSkill("bad.mjs", 'console.log("x");\n');
    const out = await promoter(FAIL).promote({ entry });
    expect(out).toEqual({ status: "rejected", reason: "boom" });
  });

  it("rejects a skill that times out", async () => {
    const entry = writeSkill("hang.mjs", 'console.log("x");\n');
    const out = await promoter(TIMEOUT).promote({ entry });
    expect(out).toEqual({ status: "rejected", reason: "sandbox timed out" });
  });
});
