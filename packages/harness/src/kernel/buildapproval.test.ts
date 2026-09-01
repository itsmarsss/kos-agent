import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Kernel } from "./kernel.js";

/**
 * Deciding a build sub-agent's permission request.
 *
 * These are queued as build.Bash, build.Read and so on, which are not
 * registered tools: the sub-agent performs the action itself once it sees the
 * decision. Running them through the tool registry looked up something that
 * does not exist, logged "unknown tool: build.Bash", and then told the parent
 * agent the thing it had just watched succeed had failed.
 */
describe("deciding a build's permission request", () => {
  let root: string;
  let kernel: Kernel;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-buildappr-"));
    kernel = await Kernel.boot({ rootDir: root });
  });

  afterEach(() => {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  });

  const queue = (tool: string): number =>
    kernel.approvals.enqueue({
      tool,
      args: { command: "git init" },
      riskTier: "risky",
      reason: "a build wants to run git init",
    }).id;

  it("approves without pretending to run a tool", async () => {
    const id = queue("build.Bash");
    const res = await kernel.approve(id);

    expect(res.ok).toBe(true);
    expect(res.isError).toBeFalsy();
    expect(res.message).toContain("Bash");
    // The bug: this used to come back as an execution failure.
    expect(res.message).not.toContain("unknown tool");

    const logged = kernel.audit.recent(5).find((a) => a.tool === "build.Bash");
    expect(logged?.isError).toBe(false);
  });

  /*
   * A build is a process that was blocked, not a conversation waiting on a
   * tool result. Resuming one tells an agent that is not waiting that
   * something it never asked for has happened.
   */
  it("does not resume a conversation on either decision", async () => {
    const approved = await kernel.approve(queue("build.Bash"));
    expect(approved.reply).toBeUndefined();

    const denied = await kernel.deny(queue("build.Read"));
    expect(denied.ok).toBe(true);
    expect(denied.reply).toBeUndefined();
    expect(denied.message).toContain("Read");
  });

  it("still runs a real tool through the registry", async () => {
    // memory.remember is registered, so this one genuinely executes.
    const id = kernel.approvals.enqueue({
      tool: "files.write",
      args: { path: "note.txt", content: "hello" },
      riskTier: "risky",
    }).id;
    const res = await kernel.approve(id);
    expect(res.ok).toBe(true);
    expect(res.message).not.toContain("unknown tool");
  });
});
