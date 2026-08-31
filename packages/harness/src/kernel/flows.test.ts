import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { isValidPageSpec, type PageSpec } from "@kos/shared";

import type { Inference } from "../agent/loop.js";
import type { Task } from "../models/router.js";
import type { GenerateRequest, ModelResponse } from "../models/types.js";
import type { KosModule } from "../modules/loader.js";
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

  it("resumes an approval in the conversation that asked for it", async () => {
    const model = scripted([
      toolCall("c1", "shell", { command: "rm -rf build" }),
      text("Queued that for you."),
      text("Removed the build directory."),
    ]);
    kernel = await boot(model.inference);
    const scoped = kernel.conversations.create({ userId: "owner", title: "Ops" });

    await kernel.handleMessage("clear the build dir", { sessionId: scoped.id });
    const pending = kernel.approvals.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.conversationId).toBe(scoped.id);

    await kernel.approve(pending[0]!.id);

    // The agent that was waiting is the one that gets the result. Resuming in
    // the primary conversation left it waiting and told the wrong reader.
    const there = JSON.stringify(kernel.sessions.get(scoped.id));
    expect(there).toContain("the owner approved pending action");
    expect(there).toContain("Removed the build directory.");
    const main = JSON.stringify(
      kernel.sessions.get(primarySessionId(kernel.profile.ownerId)),
    );
    expect(main).not.toContain("the owner approved pending action");
  });

  it("moves a conversation when an approval resumes it, without renaming", async () => {
    const model = scripted([
      toolCall("c1", "files.rm", { path: "notes/x.md" }),
      text("Queued."),
      text("Deleted it."),
    ]);
    kernel = await boot(model.inference);
    const c = kernel.conversations.create({ userId: "owner", title: "Ops" });
    await kernel.handleMessage("delete notes/x.md", { sessionId: c.id });
    // Something else moves ahead of it while the action sits in the queue.
    // Compared against that stamp rather than list position, because two
    // touches in the same millisecond fall back to insertion order.
    const other = kernel.conversations.create({ userId: "owner", title: "Later" });
    kernel.conversations.touch(other.id);
    const ahead = kernel.conversations.get(other.id)!.updatedAt;
    expect(kernel.conversations.get(c.id)!.updatedAt).toBeLessThan(ahead);

    await kernel.approve(kernel.approvals.pending()[0]!.id);

    // A reader watching the list has to see the thread move on, but the resume
    // prompt is plumbing and must not become the title.
    expect(kernel.conversations.get(c.id)!.updatedAt).toBeGreaterThanOrEqual(ahead);
    expect(kernel.conversations.get(c.id)!.title).toBe("Ops");
  });

  it("schedules a job into the running scheduler, not just the table", async () => {
    const model = scripted([
      toolCall("c1", "cron.schedule", {
        name: "MinuteCheck",
        schedule: "* * * * *",
        type: "actions",
        actions: [{ tool: "notify", args: { text: "tick" } }],
      }),
      text("Queued for approval."),
      text("Scheduled."),
    ]);
    kernel = await boot(model.inference);
    kernel.startCron();
    const before = kernel.scheduledCronCount();

    await kernel.handleMessage("check every minute");
    await kernel.approve(kernel.approvals.pending()[0]!.id);

    // The scheduler builds its tasks from the table when the host starts. A
    // job scheduled after that was stored and enabled and never fired, so the
    // owner had an unattended job that did nothing until a restart.
    expect(kernel.crons.list()).toHaveLength(before + 1);
    expect(kernel.scheduledCronCount()).toBe(before + 1);
  });

  it("keeps an agent's message when there is no channel to send it on", async () => {
    const model = scripted([
      toolCall("n1", "notify", { text: "You have spent 56.25 this month." }),
      text("Told you."),
    ]);
    kernel = await boot(model.inference);
    const c = kernel.conversations.create({ userId: "owner", title: "Work" });

    const before = kernel.sessions.get(primarySessionId(kernel.profile.ownerId)).length;
    await kernel.handleMessage("tell me the total", { sessionId: c.id });

    // With no Discord wired, notify threw and the message was simply lost, so
    // every unattended job that ended in "tell me" produced nothing at all.
    const wire = JSON.stringify(model.calls.at(-1)!.request.messages);
    expect(wire).not.toContain("no notify channel is wired");
    const main = kernel.sessions.get(primarySessionId(kernel.profile.ownerId));
    expect(main.length).toBe(before + 1);
    expect(JSON.stringify(main)).toContain("56.25");
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

  it("gives an unattended self_prompt cron the same context as a chat turn", async () => {
    const model = scripted([text("Noted."), text("Checked the budget.")]);
    kernel = await boot(model.inference);

    await kernel.handleMessage("my timezone is America/New_York");
    kernel.manifest.createProject({ name: "Budget 2026", type: "budget" });

    const job = kernel.crons.create({
      name: "weekly-review",
      schedule: "0 9 * * 1",
      type: "self_prompt",
      prompt: "review my timezone and spending",
      enabled: true,
    });

    const { runCronJob } = await import("../cron/executor.js");
    await runCronJob(job, {
      db: kernel.workspace.db,
      tools: kernel.registry,
      inference: model.inference,
      buildSystem: (j) =>
        (kernel as unknown as {
          cronSystemPrompt(j: typeof job): Promise<string>;
        }).cronSystemPrompt(j),
    });

    // Unattended runs used to get no system prompt at all: no identity, no
    // manifest, no memory.
    const prompt = model.systems.at(-1)!;
    expect(prompt).toContain("Projects (manifest)");
    expect(prompt).toContain("budget_2026");
    expect(prompt).toContain("America/New_York");
    expect(prompt).toContain("running unattended");
  });

  it("tells the model how to format when the turn came from Discord", async () => {
    const model = scripted([text("**done**")]);
    kernel = await boot(model.inference);

    await kernel.handleMessage("what did I spend", { channel: "discord" });
    expect(model.systems.at(-1)!).toContain("Replying on Discord");

    await kernel.handleMessage("and now from the CLI");
    expect(model.systems.at(-1)!).not.toContain("Replying on Discord");
  });

  it("cannot write through a cron query, even one already stored", async () => {
    const model = scripted([text("ok")]);
    kernel = await boot(model.inference);
    kernel.workspace.db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY)");

    // Bypass the store's validation to simulate a row written before the
    // guard existed, or by any other path: the executor must still refuse.
    kernel.workspace.db
      .prepare(
        `INSERT INTO crons (name, schedule, type, query, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, 0, 0)`,
      )
      .run(
        "sneaky",
        "0 3 * * *",
        "actions",
        "INSERT INTO probe (id) VALUES (1) RETURNING id",
      );

    const job = kernel.crons.list().find((j) => j.name === "sneaky")!;
    const { runCronJob } = await import("../cron/executor.js");
    await expect(
      runCronJob(job, {
        db: kernel.workspace.reader,
        tools: kernel.registry,
        inference: model.inference,
      }),
    ).rejects.toThrow();

    const rows = kernel.workspace.db
      .prepare("SELECT COUNT(*) AS n FROM probe")
      .get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it("runs an approved action through the serial queue, not alongside it", async () => {
    // Observe when the TOOL runs, not when approve() resolves: approve waits
    // on its own resume turn, which is queued anyway and would mask the race.
    const order: string[] = [];
    const marker: KosModule = {
      manifest: {
        name: "marker",
        version: "1.0.0",
        provides: [{ kind: "tool", name: "test.mark", version: "1.0.0" }],
        riskTier: "risky",
      },
      activate(ctx) {
        ctx.registerTool(
          { name: "test.mark", description: "mark", inputSchema: { type: "object" } },
          () => {
            order.push("approved action");
            return "marked";
          },
          { floor: "risky" },
        );
      },
    };

    const model = scripted([
      toolCall("c1", "test.mark", {}),
      text("Queued."),
      text("Done."),
    ]);
    root = mkdtempSync(join(tmpdir(), "kos-flow-"));
    kernel = await Kernel.boot({
      rootDir: root,
      secrets: new SecretsRegistry(),
      inference: model.inference,
      profileOverrides: { name: "Kenny", timezone: "UTC" },
      extraModules: [marker],
    });

    await kernel.handleMessage("mark it");
    const pending = kernel.approvals.pending();
    expect(pending).toHaveLength(1);

    let release!: () => void;
    const blocker = new Promise<void>((r) => (release = r));
    const occupied = kernel.queue.enqueue(async () => {
      await blocker;
      order.push("in-flight job");
    });

    const approval = kernel.approve(pending[0]!.id);

    // Ample time for an inline execution to run ahead of the blocked job.
    await new Promise((r) => setTimeout(r, 50));
    release();
    await occupied;
    await approval;

    expect(order).toEqual(["in-flight job", "approved action"]);
  });

  it("keeps parallel conversations from leaking into each other", async () => {
    const model = scripted([
      text("Noted the shoot."),
      text("Noted the budget."),
      text("Recalling the shoot."),
    ]);
    kernel = await boot(model.inference);

    const shoot = kernel.conversations.create({ userId: "owner", title: "Shoot" });
    const budget = kernel.conversations.create({ userId: "owner", title: "Budget" });

    await kernel.handleMessage("the shoot is on Tuesday", { sessionId: shoot.id });
    await kernel.handleMessage("rent is 2400 a month", { sessionId: budget.id });
    await kernel.handleMessage("when is it again", { sessionId: shoot.id });

    // The third turn must see the shoot thread and not the budget one.
    const wire = JSON.stringify(model.calls.at(-1)!.request.messages);
    expect(wire).toContain("the shoot is on Tuesday");
    expect(wire).not.toContain("rent is 2400");
  });

  it("runs conversation commands without calling the model", async () => {
    const model = scripted([text("should not be used")]);
    kernel = await boot(model.inference);

    const before = model.calls.length;
    const res = await kernel.handleChannelTurn({
      text: "/new shoot plan",
      userId: "owner",
      channel: "discord",
      });
    expect(res.isCommand).toBe(true);
    expect(model.calls.length).toBe(before);
    expect(kernel.conversations.get(res.conversationId)?.title).toBe("shoot plan");
  });

  it("gives each surface its own place in the conversation list", async () => {
    const model = scripted([text("ok"), text("ok"), text("ok")]);
    kernel = await boot(model.inference);

    await kernel.handleChannelTurn({ text: "/new from discord", userId: "owner", channel: "discord" });
    await kernel.handleChannelTurn({ text: "/new from cli", userId: "owner", channel: "cli" });

    const discord = kernel.conversationFor("discord", "owner");
    const cli = kernel.conversationFor("cli", "owner");
    // Switching on one surface must not drag the other along with it.
    expect(discord.id).not.toBe(cli.id);
    expect(discord.title).toBe("from discord");
    expect(cli.title).toBe("from cli");
  });

  it("maps a native thread to its own conversation with no command", async () => {
    const model = scripted([text("ok"), text("ok")]);
    kernel = await boot(model.inference);

    const a = await kernel.handleChannelTurn({
      text: "first thread",
      userId: "owner",
      channel: "slack",
      conversationKey: "thread-1",
    });
    const b = await kernel.handleChannelTurn({
      text: "second thread",
      userId: "owner",
      channel: "slack",
      conversationKey: "thread-2",
    });
    expect(a.conversationId).not.toBe(b.conversationId);
    expect(a.conversationId).toBe("slack:thread-1");
  });

  it("titles a conversation from its opening message", async () => {
    const model = scripted([text("ok")]);
    kernel = await boot(model.inference);

    const created = kernel.conversations.create({ userId: "owner" });
    expect(created.title).toBe("New conversation");
    await kernel.handleMessage("plan the diecast shelf build", {
      sessionId: created.id,
    });
    expect(kernel.conversations.get(created.id)?.title).toBe(
      "plan the diecast shelf build",
    );
  });

  it("keeps the pre-existing primary session as a conversation", async () => {
    const model = scripted([text("ok")]);
    kernel = await boot(model.inference);
    const primary = kernel.conversations.get(primarySessionId(kernel.profile.ownerId));
    expect(primary?.title).toBe("Main");
  });

  it("applies a conversation's brief to its turns only", async () => {
    const model = scripted([text("ok"), text("ok")]);
    kernel = await boot(model.inference);

    const scoped = kernel.conversations.create({
      userId: "owner",
      title: "App build",
      brief: "Prefer concrete steps. Ask before scaffolding files.",
    });
    const plain = kernel.conversations.create({ userId: "owner", title: "Other" });

    await kernel.handleMessage("start", { sessionId: scoped.id });
    expect(model.systems.at(-1)!).toContain("Ask before scaffolding files");

    await kernel.handleMessage("start", { sessionId: plain.id });
    expect(model.systems.at(-1)!).not.toContain("Ask before scaffolding files");
  });

  it("withholds tools outside a conversation's allow-list", async () => {
    const model = scripted([
      toolCall("c1", "cron.schedule", { name: "x", schedule: "0 9 * * 1" }),
      text("done"),
    ]);
    kernel = await boot(model.inference);

    const scoped = kernel.conversations.create({
      userId: "owner",
      title: "Reading",
      toolAllow: ["files", "search"],
    });

    await kernel.handleMessage("schedule something", { sessionId: scoped.id });

    // Not merely hidden: naming it directly has to fail too, or the list is a
    // fiction the model can step around.
    const offered = (model.calls[0]!.request.tools ?? []).map((t) => t.name);
    expect(offered.some((n) => n.startsWith("cron"))).toBe(false);
    expect(offered.some((n) => n.startsWith("files"))).toBe(true);

    const wire = JSON.stringify(model.calls.at(-1)!.request.messages);
    expect(wire).toContain("not available in this conversation");
    expect(kernel.crons.list().some((c) => c.name === "x")).toBe(false);
  });

  it("leaves an unscoped conversation with the full toolset", async () => {
    const model = scripted([text("ok")]);
    kernel = await boot(model.inference);
    const plain = kernel.conversations.create({ userId: "owner", title: "Plain" });
    await kernel.handleMessage("hello", { sessionId: plain.id });
    const offered = (model.calls[0]!.request.tools ?? []).map((t) => t.name);
    expect(offered.some((n) => n.startsWith("cron"))).toBe(true);
  });

  it("keeps the chats tools out of an ordinary conversation", async () => {
    const model = scripted([
      toolCall("c1", "chats.create", { title: "sneaky", brief: "x" }),
      text("done"),
    ]);
    kernel = await boot(model.inference);

    const plain = kernel.conversations.create({ userId: "owner", title: "Plain" });
    const before = kernel.conversations.list("owner").length;
    await kernel.handleMessage("make a chat", { sessionId: plain.id });

    // Neither offered nor reachable by naming it: reading across threads and
    // starting new ones is a different privilege level.
    const offered = (model.calls[0]!.request.tools ?? []).map((t) => t.name);
    expect(offered.some((n) => n.startsWith("chats."))).toBe(false);
    const wire = JSON.stringify(model.calls.at(-1)!.request.messages);
    expect(wire).toContain("not available in this conversation");
    expect(kernel.conversations.list("owner")).toHaveLength(before);
  });

  it("gives the orchestrator the chats tools", async () => {
    const model = scripted([text("ok")]);
    kernel = await boot(model.inference);
    await kernel.handleOrchestratorTurn("what do I have going on");
    const offered = (model.calls[0]!.request.tools ?? []).map((t) => t.name);
    expect(offered).toContain("chats.search");
    expect(offered).toContain("chats.create");
  });

  it("gives the orchestrator no tools for building things itself", async () => {
    const model = scripted([text("ok")]);
    kernel = await boot(model.inference);
    await kernel.handleOrchestratorTurn("build me a workout log");
    const offered = (model.calls[0]!.request.tools ?? []).map((t) => t.name);

    // Told only in prose to route, and handed the full toolkit, it built
    // things inline: a whole project landed in the Command thread, and a page
    // for one thing was written into whatever project already existed.
    expect(offered).toContain("chats.create");
    expect(offered).toContain("chats.dispatch");
    expect(offered.some((n) => n.startsWith("memory."))).toBe(true);
    for (const withheld of [
      "systems.project_create",
      "systems.migrate",
      "pages.write",
      "files.write",
      "sql",
      "cron.schedule",
    ]) {
      expect(offered).not.toContain(withheld);
    }
  });

  it("refuses to build inline even when the orchestrator names the tool", async () => {
    const model = scripted([
      toolCall("c1", "pages.write", { project: "x", spec: {} }),
      text("I will route that instead."),
    ]);
    kernel = await boot(model.inference);
    await kernel.handleOrchestratorTurn("write me a page");

    // Withheld in defs() is only half of it: a model can name any tool.
    const wire = JSON.stringify(model.calls.at(-1)!.request.messages);
    expect(wire).toContain("not available in this conversation");
    expect(kernel.pages.list()).toHaveLength(0);
  });

  it("leaves an ordinary conversation the full toolkit", async () => {
    const model = scripted([text("ok")]);
    kernel = await boot(model.inference);
    const c = kernel.conversations.create({ userId: "owner", title: "Work" });
    await kernel.handleMessage("build a workout log", { sessionId: c.id });
    const offered = (model.calls[0]!.request.tools ?? []).map((t) => t.name);
    expect(offered).toContain("pages.write");
    expect(offered).toContain("systems.migrate");
  });

  it("orchestrator finds an existing conversation before making another", async () => {
    const model = scripted([
      toolCall("c1", "chats.search", { query: "shoot" }),
      text("You already have one for that."),
    ]);
    kernel = await boot(model.inference);

    const shoot = kernel.conversations.create({ userId: "owner", title: "Shoot plan" });
    kernel.sessions.record(shoot.id, [
      { role: "user", content: [{ type: "text", text: "book the van for the shoot" }] },
    ]);

    await kernel.handleOrchestratorTurn("help me with the shoot");
    const wire = JSON.stringify(model.calls.at(-1)!.request.messages);
    expect(wire).toContain("Shoot plan");
  });

  it("orchestrator creates a scoped agent and hands it back", async () => {
    const model = scripted([
      toolCall("c1", "chats.create", {
        title: "App build",
        brief: "Help build the app. Ask before scaffolding.",
        toolAllow: ["files", "search"],
        task: "Carried over: stack is Postgres and Next. Start on the auth flow.",
      }),
      text("Started it."),
    ]);
    kernel = await boot(model.inference);

    await kernel.handleOrchestratorTurn("spin something up for the app");

    const made = kernel.conversations
      .list("owner")
      .find((c) => c.title === "App build");
    expect(made?.brief).toContain("Ask before scaffolding");
    expect(made?.toolAllow).toEqual(["files", "search"]);
    // The task lands as the owner asking, so the agent has something to act on.
    const first = kernel.sessions.get(made!.id)[0];
    expect(first?.role).toBe("user");
    expect(JSON.stringify(first)).toContain("Postgres and Next");
  });

  it("does not offer the orchestrator its own thread as a destination", async () => {
    const model = scripted([toolCall("c1", "chats.list", {}), text("ok")]);
    kernel = await boot(model.inference);
    await kernel.handleOrchestratorTurn("list them");
    const wire = JSON.stringify(model.calls.at(-1)!.request.messages);
    expect(wire).not.toContain("orchestrator:");
  });

  it("gives an orchestrator-created conversation the full toolkit", async () => {
    const model = scripted([
      toolCall("c1", "chats.create", { title: "App build", brief: "help build" }),
      text("Started it."),
      text("ok"),
    ]);
    kernel = await boot(model.inference);

    await kernel.handleOrchestratorTurn("spin something up for the app");
    const made = kernel.conversations.list("owner").find((c) => c.title === "App build")!;
    // A permission the model guessed at becomes a capability the conversation
    // silently lacks, so an unrequested restriction must not happen at all.
    expect(made.toolAllow).toBeNull();

    await kernel.handleMessage("do something", { sessionId: made.id });
    const offered = (model.calls.at(-1)!.request.tools ?? []).map((t) => t.name);
    expect(offered.length).toBeGreaterThan(20);
    for (const expected of ["sql", "cron.schedule", "http.fetch", "files.write"]) {
      expect(offered).toContain(expected);
    }
    // The chats tools stay out: those are the orchestrator's alone.
    expect(offered.some((n) => n.startsWith("chats."))).toBe(false);
  });

  it("lets the owner set a tool scope after the fact", async () => {
    const model = scripted([text("ok")]);
    kernel = await boot(model.inference);
    const c = kernel.conversations.create({ userId: "owner", title: "Narrow" });

    kernel.conversations.configure(c.id, { toolAllow: ["files", "search"] });
    await kernel.handleMessage("go", { sessionId: c.id });

    const offered = (model.calls.at(-1)!.request.tools ?? []).map((t) => t.name);
    expect(offered.some((n) => n.startsWith("cron"))).toBe(false);
    expect(offered.some((n) => n.startsWith("files"))).toBe(true);
  });

  it("an empty tool scope means no tools, not every tool", async () => {
    const model = scripted([text("ok")]);
    kernel = await boot(model.inference);
    const muted = kernel.conversations.create({
      userId: "owner",
      title: "Notes only",
      toolAllow: [],
    });

    await kernel.handleMessage("do something", { sessionId: muted.id });
    // Collapsing "no tools" onto "unrestricted" made this inexpressible.
    expect(model.calls.at(-1)!.request.tools ?? []).toHaveLength(0);
  });

  it("clearing the scope restores the full toolkit", async () => {
    const model = scripted([text("ok"), text("ok")]);
    kernel = await boot(model.inference);
    const c = kernel.conversations.create({
      userId: "owner",
      title: "Narrow",
      toolAllow: ["files"],
    });

    await kernel.handleMessage("go", { sessionId: c.id });
    expect((model.calls.at(-1)!.request.tools ?? []).length).toBeLessThan(12);

    kernel.conversations.configure(c.id, { toolAllow: null });
    await kernel.handleMessage("go again", { sessionId: c.id });
    expect((model.calls.at(-1)!.request.tools ?? []).length).toBeGreaterThan(20);
  });

  it("a created conversation is asked as the owner and actually runs", async () => {
    const model = scripted([
      toolCall("c1", "chats.create", {
        title: "Notes",
        brief: "keep notes",
        task: "write test3.md",
      }),
      text("It wrote test3.md."),
      text("sub-agent ran"),
    ]);
    kernel = await boot(model.inference);
    await kernel.handleOrchestratorTurn("make me a notes agent that writes a file");

    const made = kernel.conversations.list("owner").find((c) => c.title === "Notes")!;
    const transcript = kernel.sessions.get(made.id);

    // The task arrives as the owner asking, so the agent has something to act
    // on. Seeding it as KOS speaking left nothing for it to respond to.
    expect(transcript[0]?.role).toBe("user");
    expect(JSON.stringify(transcript[0])).toContain("write test3.md");
    // And it ran: there is a reply after the task.
    expect(transcript.length).toBeGreaterThan(1);
    expect(transcript.some((m) => m.role === "assistant")).toBe(true);
  });

  it("creating without a task says so rather than pretending it started", async () => {
    const model = scripted([
      toolCall("c1", "chats.create", { title: "Later", brief: "for later" }),
      text("Set it up, not started."),
    ]);
    kernel = await boot(model.inference);
    await kernel.handleOrchestratorTurn("set something up for later");

    const made = kernel.conversations.list("owner").find((c) => c.title === "Later")!;
    expect(kernel.sessions.get(made.id)).toEqual([]);
    // Read the tool result itself rather than the escaped wire form.
    const result = model.calls
      .at(-1)!
      .request.messages.flatMap((m) => m.content)
      .find((b) => b.type === "tool_result");
    expect(JSON.parse((result as { content: string }).content)).toMatchObject({
      started: false,
    });
  });

  it("orchestrator dispatches work and reports the result back", async () => {
    // Two agents share the stub: the orchestrator dispatches, the sub-agent
    // does the work, and the reply has to travel back up.
    const model = scripted([
      toolCall("c1", "chats.create", { title: "Notes", brief: "keep notes" }),
      toolCall("c2", "chats.dispatch", { id: "PLACEHOLDER", message: "write test3.md" }),
      text("Done: it wrote test3.md."),
    ]);
    kernel = await boot(model.inference);
    await kernel.handleOrchestratorTurn("make me a notes agent");

    const made = kernel.conversations.list("owner").find((c) => c.title === "Notes");
    expect(made).toBeTruthy();
  });

  it("dispatch runs the target conversation and returns its reply", async () => {
    let seenBrief = "";
    let turn = 0;
    const inference: Inference = {
      async generate(_t, req) {
        turn += 1;
        seenBrief = req.system ?? "";
        return {
          content: [{ type: "text", text: turn === 1 ? "sub-agent answered" : "ok" }],
          stopReason: "end_turn" as const,
          usage: { inputTokens: 0, outputTokens: 0 },
          model: "stub",
        };
      },
    };
    kernel = await boot(inference);
    const target = kernel.conversations.create({
      userId: "owner",
      title: "Notes",
      brief: "You keep terse notes.",
    });

    const res = await kernel.dispatchTo(target.id, "write it down");
    expect(res.reply).toBe("sub-agent answered");
    // It ran as that conversation, with that conversation's brief.
    expect(seenBrief).toContain("You keep terse notes");
    // And the exchange is in its transcript, not the dispatcher's.
    expect(JSON.stringify(kernel.sessions.get(target.id))).toContain("write it down");
  });

  it("dispatching from inside a queued turn does not deadlock", async () => {
    const model = scripted([text("sub-agent done"), text("ok")]);
    kernel = await boot(model.inference);
    const target = kernel.conversations.create({ userId: "owner", title: "Worker" });

    // The real shape: dispatch happens inside a job that already holds the
    // queue slot. Enqueuing there waits on the task doing the waiting.
    const inSlot = kernel.queue.enqueue(async () => {
      const res = await kernel.dispatchTo(target.id, "go");
      return res.reply;
    });

    const outcome = await Promise.race([
      inSlot,
      new Promise((r) => setTimeout(() => r("DEADLOCK"), 3000)),
    ]);
    expect(outcome).toBe("sub-agent done");
  });

  it("one conversation remembers, another recalls it", async () => {
    const model = scripted([
      toolCall("m1", "memory.remember", {
        key: "deploy target",
        value: "Fly.io, iad region",
        tags: ["infra"],
      }),
      text("Noted."),
      toolCall("m2", "memory.recall", { query: "deploy" }),
      text("Fly.io."),
    ]);
    kernel = await boot(model.inference);
    const a = kernel.conversations.create({ userId: "owner", title: "Infra" });
    const b = kernel.conversations.create({ userId: "owner", title: "Other" });

    await kernel.handleMessage("we settled on fly", { sessionId: a.id });
    // The key is normalised, so a restatement updates rather than duplicating.
    expect(kernel.facts.get("owner", "deploy_target")?.value).toContain("Fly.io");

    await kernel.handleMessage("where do we deploy", { sessionId: b.id });
    const wire = JSON.stringify(model.calls.at(-1)!.request.messages);
    // Knowledge is shared: what one conversation learned, another can reach.
    expect(wire).toContain("Fly.io");
  });

  it("attributes an entry to the conversation that wrote it", async () => {
    const model = scripted([
      toolCall("m1", "memory.remember", { key: "x", value: "y" }),
      text("ok"),
    ]);
    kernel = await boot(model.inference);
    const c = kernel.conversations.create({ userId: "owner", title: "Writer" });
    await kernel.handleMessage("remember it", { sessionId: c.id });
    expect(kernel.facts.get("owner", "x")?.source).toBe(c.id);
  });

  it("puts pinned knowledge in every conversation without a match", async () => {
    const model = scripted([text("ok")]);
    kernel = await boot(model.inference);
    kernel.facts.upsert(
      "owner",
      { key: "timezone", value: "America/New_York", kind: "fact", pinned: true },
      "dashboard",
    );
    const c = kernel.conversations.create({ userId: "owner", title: "Unrelated" });

    // Nothing in this message matches the entry; pinning is what gets it in.
    await kernel.handleMessage("write a poem about ducks", { sessionId: c.id });
    expect(model.systems.at(-1)!).toContain("America/New_York");
    expect(model.systems.at(-1)!).toContain("pinned");
  });

  it("scopes recall to a tag when asked", async () => {
    const model = scripted([
      toolCall("m1", "memory.recall", { tags: ["infra"] }),
      text("ok"),
    ]);
    kernel = await boot(model.inference);
    kernel.facts.upsert("owner", { key: "host", value: "fly", kind: "fact", tags: ["infra"] });
    kernel.facts.upsert("owner", { key: "coffee", value: "oat", kind: "preference", tags: ["personal"] });
    const c = kernel.conversations.create({ userId: "owner", title: "Infra" });

    await kernel.handleMessage("what infra do we have", { sessionId: c.id });
    const result = model.calls
      .at(-1)!
      .request.messages.flatMap((m) => m.content)
      .find((b) => b.type === "tool_result");
    const rows = JSON.parse((result as { content: string }).content) as Array<{ key: string }>;
    expect(rows.map((r) => r.key)).toEqual(["host"]);
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
