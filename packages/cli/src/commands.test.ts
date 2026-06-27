import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, SecretsRegistry } from "@kos/harness";
import type { Inference } from "@kos/harness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseArgs, runCommand, statusLine } from "./commands.js";

const stubInference: Inference = {
  async generate() {
    return {
      content: [{ type: "text", text: "ok" }],
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0 },
      model: "stub",
    };
  },
};

describe("parseArgs", () => {
  it("defaults to chat", () => {
    expect(parseArgs([])).toEqual({ command: "chat", rest: [], flags: {} });
  });

  it("parses a command, positionals, and flags", () => {
    expect(parseArgs(["once", "hello", "world", "--workspace", "/tmp/x"])).toEqual({
      command: "once",
      rest: ["hello", "world"],
      flags: { workspace: "/tmp/x" },
    });
  });

  it("treats a trailing flag as boolean", () => {
    expect(parseArgs(["status", "--json"]).flags).toEqual({ json: true });
  });
});

describe("runCommand", () => {
  let root: string;
  let kernel: Kernel;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-cli-"));
    kernel = await Kernel.boot({
      rootDir: root,
      secrets: new SecretsRegistry(),
      inference: stubInference,
    });
  });

  afterEach(() => {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("reports status", async () => {
    expect(await runCommand(kernel, "status", [])).toMatch(/kill switch: running/);
    expect(statusLine(kernel)).toMatch(/queue depth: 0/);
  });

  it("halts and resumes the kill switch", async () => {
    await runCommand(kernel, "halt", []);
    expect(kernel.killSwitch.halted).toBe(true);
    await runCommand(kernel, "resume", []);
    expect(kernel.killSwitch.halted).toBe(false);
  });

  it("lists and resolves approvals end to end", async () => {
    // create a pending risky action via a risky tool call
    kernel.approvals.enqueue({
      tool: "files.read",
      args: { path: "x" },
      riskTier: "risky",
    });
    expect(await runCommand(kernel, "approvals", [])).toMatch(/#1 files.read/);
    const out = await runCommand(kernel, "approve", ["1"]);
    expect(typeof out).toBe("string");
    expect(kernel.approvals.pending()).toHaveLength(0);
  });

  it("rejects approve without a valid id", async () => {
    expect(await runCommand(kernel, "approve", [])).toMatch(/usage: approve/);
  });

  it("lists crons after scheduling one", async () => {
    kernel.crons.create({ name: "j", schedule: "0 0 1 1 *", type: "actions" });
    expect(await runCommand(kernel, "crons", [])).toMatch(/#1 j/);
  });

  it("snapshots the workspace", async () => {
    expect(await runCommand(kernel, "snapshot", ["test"])).toMatch(/snapshot|nothing/);
  });

  it("returns help for an unknown command", async () => {
    expect(await runCommand(kernel, "bogus", [])).toMatch(/unknown command/);
  });
});
