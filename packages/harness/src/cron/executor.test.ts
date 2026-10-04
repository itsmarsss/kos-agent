import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import type { Inference } from "../agent/loop.js";
import type { ModelResponse } from "../models/types.js";
import { Workspace } from "../store/workspace.js";
import { runCronJob } from "./executor.js";
import type { CronJob } from "./types.js";

function job(partial: Partial<CronJob>): CronJob {
  return {
    id: 1,
    name: "j",
    schedule: "* * * * *",
    type: "actions",
    query: null,
    condition: null,
    actions: null,
    prompt: null,
    projectSlug: null,
    task: "reasoning",
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

describe("runCronJob", () => {
  let root: string;
  let ws: Workspace;
  let registry: ToolRegistry;
  let sent: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-cron-exec-"));
    ws = Workspace.open(root);
    ws.db.exec("CREATE TABLE tx (amount REAL)");
    ws.db.prepare("INSERT INTO tx (amount) VALUES (150), (100)").run();
    registry = new ToolRegistry();
    sent = [];
    registry.register(
      { name: "notify", description: "notify", inputSchema: { type: "object" } },
      (input) => {
        sent.push(String(input.text));
        return "sent";
      },
    );
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("runs actions with templated args when the condition passes", async () => {
    const res = await runCronJob(
      job({
        type: "actions",
        query: "SELECT SUM(amount) AS total FROM tx",
        condition: { test: "total > 200" },
        actions: [{ tool: "notify", args: { text: "you spent {total}" } }],
      }),
      { db: ws.db, tools: registry },
    );
    expect(res.ran).toBe(true);
    expect(sent).toEqual(["you spent 250"]);
  });

  it("skips when the condition fails", async () => {
    const res = await runCronJob(
      job({
        type: "actions",
        query: "SELECT SUM(amount) AS total FROM tx",
        condition: { test: "total > 9999" },
        actions: [{ tool: "notify", args: { text: "x" } }],
      }),
      { db: ws.db, tools: registry },
    );
    expect(res).toEqual({ ran: false, reason: "condition" });
    expect(sent).toEqual([]);
  });

  it("runs a self_prompt through the agent loop", async () => {
    const inference: Inference = {
      async generate(): Promise<ModelResponse> {
        return {
          content: [{ type: "text", text: "reviewed" }],
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0 },
          model: "mock",
        };
      },
    };
    const res = await runCronJob(
      job({ type: "self_prompt", prompt: "review {total}", query: "SELECT 5 AS total" }),
      { db: ws.db, tools: registry, inference },
    );
    expect(res).toEqual({ ran: true, type: "self_prompt", finalText: "reviewed" });
  });

  it("throws if a self_prompt has no inference provider", async () => {
    await expect(
      runCronJob(job({ type: "self_prompt", prompt: "x" }), {
        db: ws.db,
        tools: registry,
      }),
    ).rejects.toThrow(/requires an inference/);
  });
});
