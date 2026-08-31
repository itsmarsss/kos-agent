import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { runSkillLive } from "../skills/run.js";
import { runSandbox } from "./runner.js";

/**
 * What a spawned skill can see of the host.
 *
 * The secrets registry says values live in the process environment so that the
 * jail keeps the agent away from them. That reasoning only holds while nothing
 * hands the environment to agent-written code. A child process is the one
 * place that can, so it is the one place worth a test.
 */
describe("what a spawned skill inherits", () => {
  let root: string;
  let ws: Workspace;

  /** A skill that reports the environment it was handed. */
  const REPORTER = `
    const keys = Object.keys(process.env).sort();
    console.log(JSON.stringify({ keys, openai: process.env.OPENAI_API_KEY ?? null }));
  `;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-env-"));
    ws = Workspace.open(root);
    writeFileSync(join(ws.root, "reporter.js"), REPORTER);
    process.env.OPENAI_API_KEY = "sk-test-must-not-leak";
    process.env.KOS_SECRET_DISCORD = "discord-must-not-leak";
    process.env.AWS_SECRET_ACCESS_KEY = "aws-must-not-leak";
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.KOS_SECRET_DISCORD;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  const report = (stdout: string): { keys: string[]; openai: string | null } =>
    JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as {
      keys: string[];
      openai: string | null;
    };

  it("does not hand the owner's api keys to a sandboxed skill", async () => {
    const result = await runSandbox({ workspaceRoot: ws.root, entry: "reporter.js" });
    const seen = report(result.stdout);
    expect(seen.openai).toBeNull();
    expect(seen.keys).not.toContain("OPENAI_API_KEY");
    expect(seen.keys).not.toContain("KOS_SECRET_DISCORD");
    expect(seen.keys).not.toContain("AWS_SECRET_ACCESS_KEY");
  });

  it("does not hand them to a promoted skill running live either", async () => {
    const result = await runSkillLive({ workspaceRoot: ws.root, entry: "reporter.js" });
    const seen = report(result.stdout);
    expect(seen.openai).toBeNull();
    expect(seen.keys).not.toContain("KOS_SECRET_DISCORD");
    expect(seen.keys).not.toContain("AWS_SECRET_ACCESS_KEY");
  });

  it("still passes the variables a skill needs to do its job", async () => {
    const result = await runSandbox({ workspaceRoot: ws.root, entry: "reporter.js" });
    const seen = report(result.stdout);
    expect(seen.keys).toContain("KOS_DB");
    expect(seen.keys).toContain("KOS_SANDBOX");
    expect(seen.keys).toContain("KOS_DRY_RUN");
    expect(seen.keys).toContain("PATH");
  });
});
