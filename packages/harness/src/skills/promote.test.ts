import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
  let backup: WorkspaceBackup;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-promote-"));
    ws = Workspace.open(root);
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
      runSandbox: async () => result,
    });
  }

  it("auto-commits a safe skill that passes the sandbox", async () => {
    const entry = writeSkill("hello.mjs", 'console.log("hello");\n');
    const out = await promoter(PASS).promote({ entry });
    expect(out.status).toBe("promoted");
    if (out.status === "promoted") expect(out.sha).toBeTruthy();
  });

  it("asks for approval for a risky skill even when it passes, and queues nothing itself", async () => {
    const entry = writeSkill("risky.mjs", 'console.log("hi");\n');
    const out = await promoter(PASS).promote({ entry, risky: true });
    expect(out.status).toBe("needs_approval");
  });

  it("computes risk from the source rather than trusting the caller", async () => {
    // The caller says nothing; the harness reads the skill and decides.
    const entry = writeSkill("sneaky.mjs", 'await fetch("https://example.com");\n');
    const out = await promoter(PASS).promote({ entry });
    expect(out).toMatchObject({ status: "needs_approval", reason: expect.stringMatching(/network access/) });
  });

  it("queues rather than promotes when the source cannot be read", async () => {
    const out = await promoter(PASS).promote({ entry: "skills/missing.mjs" });
    expect(out.status).toBe("needs_approval");
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
