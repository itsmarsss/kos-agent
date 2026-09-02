import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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

  it("offers a stable tool set across turns regardless of wording", async () => {
    // The flicker: scope was inferred from the latest message alone, so a
    // follow-up matching no keyword changed which tools the model could see.
    const offered: string[][] = [];
    const inference: Inference = {
      async generate(_t, req: GenerateRequest): Promise<ModelResponse> {
        offered.push((req.tools ?? []).map((t) => t.name).sort());
        return {
          content: [{ type: "text", text: "ok" }],
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0 },
          model: "stub",
        };
      },
    };
    kernel = await boot(inference);

    await kernel.handleMessage("build me a budget tracker page");
    await kernel.handleMessage("add groceries for forty dollars");
    await kernel.handleMessage("thanks");

    expect(offered).toHaveLength(3);
    expect(offered[0]!.length).toBeGreaterThan(0);
    expect(offered[1]).toEqual(offered[0]);
    expect(offered[2]).toEqual(offered[0]);
  });

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

  it("carries one turn through an approval rather than starting another", async () => {
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
        // The next thing the model says comes after the tool actually ran.
        // There is no second turn to script: approval releases the call
        // inside the turn that made it.
        {
          content: [{ type: "text", text: "continued after approve" }],
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0 },
          model: "stub",
        },
      ]),
    );
    // The turn answers straight away that it is waiting, and keeps waiting.
    const first = await kernel.handleMessage("delete stuff");
    expect(first.reply).toMatch(/needs approval/);

    const pending = kernel.approvals.pending()[0]!;
    const res = await kernel.approve(pending.id);
    expect(res.ok).toBe(true);

    // The same turn carries on and lands in the same transcript, rather than
    // a second turn starting to continue the first.
    await vi.waitFor(() => {
      const said = JSON.stringify(kernel.sessions.get("chat:owner"));
      expect(said).toContain("continued after approve");
    });
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
