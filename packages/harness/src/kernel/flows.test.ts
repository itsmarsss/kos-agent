import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { isValidPageSpec, type PageSpec } from "@kos/shared";

import type { Inference } from "../agent/loop.js";
import type { Task } from "../models/router.js";
import type { GenerateRequest, ModelResponse } from "../models/types.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Kernel } from "./kernel.js";
import { primarySessionId } from "./session.js";

/**
 * End-to-end flows through the real kernel: real modules, real workspace, real
 * jail, real risk tiers, with only the model scripted.
 *
 * These cover the seams unit tests cannot. Every defect this suite was written
 * for passed its own component's unit tests while the product was broken,
 * because nothing exercised the wiring between them.
 */

interface Recorded {
  task: Task;
  request: GenerateRequest;
}

interface Scripted {
  inference: Inference;
  /** Every reasoning-task request the kernel made, in order. */
  calls: Recorded[];
  /** System prompts assembled for each reasoning turn. */
  systems: string[];
}

function text(body: string): ModelResponse {
  return {
    content: [{ type: "text", text: body }],
    stopReason: "end_turn",
    usage: { inputTokens: 0, outputTokens: 0 },
    model: "stub",
  };
}

function toolCall(
  id: string,
  name: string,
  input: Record<string, unknown>,
): ModelResponse {
  return {
    content: [{ type: "tool_use", id, name, input }],
    stopReason: "tool_use",
    usage: { inputTokens: 0, outputTokens: 0 },
    model: "stub",
  };
}

/**
 * A model driven by a fixed script. Cheap-task calls (the salience confirmer)
 * are answered separately so they never consume a scripted reasoning turn.
 */
function scripted(script: ModelResponse[]): Scripted {
  const queue = [...script];
  const calls: Recorded[] = [];
  const systems: string[] = [];
  return {
    calls,
    systems,
    inference: {
      async generate(task: Task, request: GenerateRequest): Promise<ModelResponse> {
        if (task === "cheap") return text('{"facts":[]}');
        calls.push({ task, request });
        systems.push(request.system ?? "");
        return queue.shift() ?? text("done");
      },
    },
  };
}

describe("KOS end-to-end flows", () => {
  let root: string;
  let kernel: Kernel;

  afterEach(() => {
    kernel?.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function boot(inference: Inference): Promise<Kernel> {
    root = mkdtempSync(join(tmpdir(), "kos-flow-"));
    return Kernel.boot({
      rootDir: root,
      secrets: new SecretsRegistry(),
      inference,
      profileOverrides: { name: "Kenny", timezone: "UTC" },
    });
  }

  it("builds a tracker in one turn: project, table, and page", async () => {
    const model = scripted([
      toolCall("c1", "systems.project_create", {
        name: "Budget 2026",
        type: "budget",
      }),
      toolCall("c2", "systems.migrate", {
        project: "budget_2026",
        spec: {
          op: "create_table",
          table: "tx",
          columns: [
            { name: "id", type: "INTEGER", primaryKey: true },
            { name: "amount", type: "REAL" },
            { name: "note", type: "TEXT" },
          ],
        },
      }),
      toolCall("c3", "pages.write", {
        project: "budget_2026",
        spec: {
          id: "budget",
          title: "Budget Tracker",
          widgets: [
            {
              type: "stat",
              label: "Spent",
              query: "SELECT SUM(amount) FROM budget_2026_tx",
            },
            {
              type: "form",
              title: "Add",
              mutate: { table: "budget_2026_tx", columns: ["amount", "note"] },
            },
          ],
        },
      }),
      text("Built your budget tracker."),
    ]);
    kernel = await boot(model.inference);

    const res = await kernel.handleMessage("build me a budget tracker");

    // The whole build completed without stopping for an approval. Before the
    // risk retier, every migrate blocked here and the flow could not finish.
    expect(kernel.approvals.pending()).toHaveLength(0);
    expect(res.reply).toContain("Built your budget tracker");

    const project = kernel.manifest.get("budget_2026");
    expect(project).toBeTruthy();

    // The namespaced table really exists and accepts a row.
    kernel.workspace.db
      .prepare("INSERT INTO budget_2026_tx (amount, note) VALUES (?, ?)")
      .run(12.5, "coffee");

    const page = kernel.pages.get("budget");
    expect(page).toBeTruthy();
    expect(isValidPageSpec(page!.spec as PageSpec)).toBe(true);
  });

  it("carries tool results into the next turn", async () => {
    const model = scripted([
      toolCall("c1", "systems.project_create", {
        name: "Budget 2026",
        type: "budget",
      }),
      text("Created budget_2026."),
      text("Added it."),
    ]);
    kernel = await boot(model.inference);

    await kernel.handleMessage("make me a budget");
    await kernel.handleMessage("add groceries for forty dollars");

    // The follow-up turn must be able to see what the first turn actually did.
    // With tool blocks stripped, the slug survived only if the model happened
    // to say it out loud, so follow-ups re-created or invented resources.
    const followUp = model.calls.at(-1)!.request;
    const wire = JSON.stringify(followUp.messages);
    expect(wire).toContain("systems.project_create");
    expect(wire).toContain("budget_2026");

    // Every tool_use in the replayed history still has its matching result.
    const useIds = new Set<string>();
    const resultIds = new Set<string>();
    for (const m of followUp.messages) {
      for (const b of m.content) {
        if (b.type === "tool_use") useIds.add(b.id);
        if (b.type === "tool_result") resultIds.add(b.toolUseId);
      }
    }
    expect([...useIds].every((id) => resultIds.has(id))).toBe(true);
  });

  it("queues a risky write, then resumes the plan after approval", async () => {
    const model = scripted([
      toolCall("c1", "systems.project_create", { name: "Budget", type: "budget" }),
      toolCall("c2", "systems.migrate", {
        project: "budget",
        spec: {
          op: "create_table",
          table: "tx",
          columns: [
            { name: "id", type: "INTEGER", primaryKey: true },
            { name: "amount", type: "REAL" },
          ],
        },
      }),
      // A write escalates to risky and must not execute inline.
      toolCall("c3", "sql", {
        sql: "INSERT INTO budget_tx (amount) VALUES (?)",
        params: [40],
      }),
      text("Queued that for your approval."),
      // Resume turn after approval: the row already exists, so do not repeat it.
      text("Added the 40 dollar row."),
    ]);
    kernel = await boot(model.inference);

    await kernel.handleMessage("log a forty dollar expense");

    const pending = kernel.approvals.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.tool).toBe("sql");

    // Nothing was written while the action sat in the queue.
    const before = kernel.workspace.db
      .prepare("SELECT COUNT(*) AS n FROM budget_tx")
      .get() as { n: number };
    expect(before.n).toBe(0);

    const outcome = await kernel.approve(pending[0]!.id);
    expect(outcome.ok).toBe(true);

    const after = kernel.workspace.db
      .prepare("SELECT COUNT(*) AS n FROM budget_tx")
      .get() as { n: number };
    expect(after.n).toBe(1);
    expect(kernel.approvals.pending()).toHaveLength(0);
  });

  it("remembers a stated fact and recalls it on a later turn", async () => {
    const model = scripted([text("Noted."), text("You are in America/New_York.")]);
    kernel = await boot(model.inference);

    await kernel.handleMessage("my timezone is America/New_York");
    // Heuristics catch this one outright, so it is durable without the model.
    expect(kernel.facts.get("owner", "timezone")?.value).toBe("America/New_York");

    await kernel.handleMessage("wait what timezone am I in again?");

    // Recall used to LIKE the entire sentence, so this never matched and the
    // fact never reached the prompt.
    const recallPrompt = model.systems.at(-1)!;
    expect(recallPrompt).toContain("Salient memory");
    expect(recallPrompt).toContain("America/New_York");
  });

  it("keeps harness resume turns out of the owner's memory", async () => {
    const model = scripted([
      toolCall("c1", "http.fetch", { url: "https://example.com" }),
      text("Queued."),
      text("Done."),
    ]);
    kernel = await boot(model.inference);

    await kernel.handleMessage("fetch example.com for me");
    const pending = kernel.approvals.pending();
    expect(pending).toHaveLength(1);

    await kernel.approve(pending[0]!.id);

    // The resume prompt is harness plumbing, not something the owner said, so
    // it must not become an episode or a remembered fact.
    const facts = kernel.facts.all("owner");
    expect(facts.some((f) => f.value.includes("pending action"))).toBe(false);
  });

  it("shares one session across the CLI and Discord surfaces", async () => {
    const model = scripted([text("first"), text("second")]);
    kernel = await boot(model.inference);

    const sessionId = primarySessionId(kernel.profile.ownerId);
    await kernel.handleMessage("hello from the CLI", { sessionId });
    await kernel.handleMessage("and from Discord", { sessionId });

    const wire = JSON.stringify(model.calls.at(-1)!.request.messages);
    expect(wire).toContain("hello from the CLI");
  });
});
