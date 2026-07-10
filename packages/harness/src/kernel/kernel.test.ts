import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Inference } from "../agent/loop.js";
import type { GenerateRequest, ModelResponse } from "../models/types.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Kernel } from "./kernel.js";

/** Inference stub: optionally emits one tool call on the first turn. */
function stubInference(script: ModelResponse[]): Inference {
  const queue = [...script];
  return {
    async generate(_t, _r: GenerateRequest): Promise<ModelResponse> {
      return (
        queue.shift() ?? {
          content: [{ type: "text", text: "done" }],
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0 },
          model: "stub",
        }
      );
    },
  };
}

describe("Kernel", () => {
  let root: string;
  let kernel: Kernel;

  afterEach(() => {
    kernel?.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function boot(inference: Inference, notify?: (t: string) => Promise<void>): Promise<Kernel> {
    root = mkdtempSync(join(tmpdir(), "kos-kernel-"));
    return Kernel.boot({
      rootDir: root,
      secrets: new SecretsRegistry(),
      inference,
      ...(notify ? { notify } : {}),
      profileOverrides: { name: "Kenny", timezone: "UTC" },
    });
  }

  it("boots with first-party tool modules loaded", async () => {
    kernel = await boot(stubInference([]));
    expect(kernel.loadReport.failed).toEqual([]);
    for (const t of [
      "files.read",
      "sql",
      "notify",
      "http.fetch",
      "search.grep",
      "cron.schedule",
    ]) {
      expect(kernel.registry.has(t)).toBe(true);
    }
    expect(kernel.profile.name).toBe("Kenny");
  });

  it("runs a plain turn and returns the reply", async () => {
    kernel = await boot(
      stubInference([
        {
          content: [{ type: "text", text: "hello there" }],
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0 },
          model: "stub",
        },
      ]),
    );
    const res = await kernel.handleMessage("hi");
    expect(res.reply).toBe("hello there");
    expect(res.halted).toBe(false);
    expect(res.sessionId).toBeTruthy();
    expect(kernel.runs.recent()[0]?.status).toBe("ok");
  });

  it("loads systems and tasks modules and keeps session history", async () => {
    kernel = await boot(
      stubInference([
        {
          content: [{ type: "text", text: "first" }],
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0 },
          model: "stub",
        },
        {
          content: [{ type: "text", text: "second" }],
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0 },
          model: "stub",
        },
      ]),
    );
    expect(kernel.registry.has("systems.project_create")).toBe(true);
    expect(kernel.registry.has("tasks.add")).toBe(true);
    expect(kernel.crons.list().some((j) => j.name === "kos.backup")).toBe(true);
    await kernel.handleMessage("hi");
    await kernel.handleMessage("again");
    expect(kernel.sessions.get("chat:owner").length).toBeGreaterThanOrEqual(2);
  });

  it("executes a safe tool call end to end (files.write then notify)", async () => {
    const sent: string[] = [];
    kernel = await boot(
      stubInference([
        {
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "files.write",
              input: { path: "scratch/note.txt", content: "saved" },
            },
          ],
          stopReason: "tool_use",
          usage: { inputTokens: 0, outputTokens: 0 },
          model: "stub",
        },
        {
          content: [{ type: "text", text: "wrote the file" }],
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0 },
          model: "stub",
        },
      ]),
      async (t) => {
        sent.push(t);
      },
    );
    const res = await kernel.handleMessage("save a note");
    expect(res.reply).toBe("wrote the file");
    // the safe tool ran and was audited
    expect(kernel.audit.recent().some((a) => a.tool === "files.write")).toBe(true);
  });

  it("queues a risky tool call instead of executing it", async () => {
    kernel = await boot(
      stubInference([
        {
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "sql",
              input: { sql: "DELETE FROM x" },
            },
          ],
          stopReason: "tool_use",
          usage: { inputTokens: 0, outputTokens: 0 },
          model: "stub",
        },
        {
          content: [{ type: "text", text: "queued it" }],
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0 },
          model: "stub",
        },
      ]),
    );
    await kernel.handleMessage("delete stuff");
    expect(kernel.approvals.pending()).toHaveLength(1);
    expect(kernel.approvals.pending()[0]?.tool).toBe("sql");
  });

  it("refuses to run when the kill switch is engaged", async () => {
    kernel = await boot(stubInference([]));
    kernel.killSwitch.halt();
    const res = await kernel.handleMessage("anything");
    expect(res.halted).toBe(true);
  });

  it("resumes the agent after approving a queued action", async () => {
    kernel = await boot(
      stubInference([
        {
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "sql",
              input: { sql: "DELETE FROM x" },
            },
          ],
          stopReason: "tool_use",
          usage: { inputTokens: 0, outputTokens: 0 },
          model: "stub",
        },
        {
          content: [{ type: "text", text: "queued it" }],
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0 },
          model: "stub",
        },
        // resume after approve
        {
          content: [{ type: "text", text: "continued after approve" }],
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0 },
          model: "stub",
        },
      ]),
    );
    await kernel.handleMessage("delete stuff");
    const pending = kernel.approvals.pending()[0]!;
    const res = await kernel.approve(pending.id);
    expect(res.ok).toBe(true);
    expect(res.reply).toBe("continued after approve");
  });

  it("runs a scheduled actions job through the guarded path", async () => {
    const sent: string[] = [];
    kernel = await boot(stubInference([]), async (t) => {
      sent.push(t);
    });
    const job = kernel.crons.create({
      name: "ping",
      schedule: "0 0 1 1 *",
      type: "actions",
      actions: [{ tool: "notify", args: { text: "scheduled hi" } }],
    });
    kernel.startCron();
    // fire directly rather than waiting for the cron tick
    const sched = (kernel as unknown as { scheduler: { fire: (j: typeof job) => Promise<unknown> } }).scheduler;
    await sched.fire(job);
    await kernel.queue.drain();
    expect(sent).toEqual(["scheduled hi"]);
    expect(kernel.runs.recent().some((r) => r.kind === "cron" && r.status === "ok")).toBe(
      true,
    );
    kernel.stopCron();
  });
});
