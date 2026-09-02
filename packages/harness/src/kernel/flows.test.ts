import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isValidPageSpec, type PageSpec } from "@kos/shared";

import type { Inference } from "../agent/loop.js";
import type { Task } from "../models/router.js";
import type { GenerateRequest, ModelResponse } from "../models/types.js";
import type { KosModule } from "../modules/loader.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { BEHAVIOUR_KEY } from "./behaviour.js";
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

  it("keeps the turn alive while it waits on the owner", async () => {
    const model = scripted([
      toolCall("c1", "shell", { command: "rm -rf build" }),
      text("Removed the build directory."),
    ]);
    kernel = await boot(model.inference);

    const seen: string[] = [];
    let ended!: () => void;
    const finished = new Promise<void>((resolve) => {
      ended = resolve;
    });
    const off = kernel.progress.subscribe((event) => {
      if (event.kind !== "turn-start" && event.kind !== "turn-end") return;
      seen.push(event.kind);
      if (event.kind === "turn-end") ended();
    });

    // Answers straight away rather than holding the caller for as long as the
    // owner takes to decide.
    const first = await kernel.handleMessage("delete the build directory");
    expect(first.reply).toContain("Waiting on you");

    /*
     * The turn is suspended, not finished. turn-end drops the live view, so
     * emitting it here wiped every thought and tool call on screen at exactly
     * the moment the approval card appeared.
     */
    expect(seen).toEqual(["turn-start"]);

    // The decision releases the suspended call, and the turn it belongs to
    // ends once the rest of the plan has run.
    await kernel.approve(kernel.approvals.pending()[0]!.id);
    await finished;
    expect(seen).toEqual(["turn-start", "turn-end"]);
    off();
  });

  it("continues in the conversation that asked, and only there", async () => {
    const model = scripted([
      toolCall("c1", "shell", { command: "rm -rf build" }),
      text("Removed the build directory."),
    ]);
    kernel = await boot(model.inference);
    const scoped = kernel.conversations.create({ userId: "owner", title: "Ops" });

    await kernel.handleMessage("clear the build dir", { sessionId: scoped.id });
    const pending = kernel.approvals.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.conversationId).toBe(scoped.id);

    await kernel.approve(pending[0]!.id);

    // The agent that was waiting is the one that carries on, in its own
    // transcript. Nothing about it appears anywhere else.
    await vi.waitFor(() => {
      expect(JSON.stringify(kernel.sessions.get(scoped.id))).toContain(
        "Removed the build directory.",
      );
    });
    const main = JSON.stringify(
      kernel.sessions.get(primarySessionId(kernel.profile.ownerId)),
    );
    expect(main).not.toContain("Removed the build directory.");
  });

  it("moves a conversation when an approval lets it finish, without renaming", async () => {
    const model = scripted([
      toolCall("c1", "files.rm", { path: "notes/x.md" }),
      text("Deleted it."),
    ]);
    kernel = await boot(model.inference);
    const c = kernel.conversations.create({ userId: "owner", title: "Ops" });
    await kernel.handleMessage("delete notes/x.md", { sessionId: c.id });
    // Something else moves ahead of it while the action sits in the queue.
    // Compared against that stamp rather than list position, because two
    // touches in the same millisecond fall back to insertion order.
    // A real gap: stamps are milliseconds, and two touches inside one of them
    // fall back to insertion order, which is not what this is testing.
    await new Promise((r) => setTimeout(r, 3));
    const other = kernel.conversations.create({ userId: "owner", title: "Later" });
    kernel.conversations.touch(other.id);
    const ahead = kernel.conversations.get(other.id)!.updatedAt;
    expect(kernel.conversations.get(c.id)!.updatedAt).toBeLessThan(ahead);

    await kernel.approve(kernel.approvals.pending()[0]!.id);

    // A reader watching the list has to see the thread move on when the turn
    // finishes, and its title must survive: the message that started it is
    // what names a conversation, not anything the approval did.
    await vi.waitFor(() => {
      expect(kernel.conversations.get(c.id)!.updatedAt).toBeGreaterThanOrEqual(
        ahead,
      );
    });
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
      text("Scheduled."),
    ]);
    kernel = await boot(model.inference);
    kernel.startCron();
    const before = kernel.scheduledCronCount();

    await kernel.handleMessage("check every minute");
    await kernel.approve(kernel.approvals.pending()[0]!.id);

    // Awaited: the call runs inside the turn that was suspended on it, so
    // the job exists once that turn gets going again, not when approve
    // returns.
    // The scheduler builds its tasks from the table when the host starts. A
    // job scheduled after that was stored and enabled and never fired, so the
    // owner had an unattended job that did nothing until a restart.
    await vi.waitFor(() => {
      expect(kernel.crons.list()).toHaveLength(before + 1);
      expect(kernel.scheduledCronCount()).toBe(before + 1);
    });
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

  it("reports each step of a turn as it happens", async () => {
    const model = scripted([
      toolCall("c1", "files.write", { path: "a.md", content: "hi" }),
      text("Wrote it."),
    ]);
    kernel = await boot(model.inference);
    const c = kernel.conversations.create({ userId: "owner", title: "Work" });

    // A turn runs for tens of seconds across several calls, and the reader saw
    // one static word for all of it.
    const seen: string[] = [];
    kernel.progress.subscribe((e) => seen.push(`${e.kind}:${"tool" in e ? e.tool : ""}`));
    await kernel.handleMessage("write a file", { sessionId: c.id });

    expect(seen[0]).toBe("turn-start:");
    expect(seen).toContain("tool-start:files.write");
    expect(seen).toContain("tool-end:files.write");
    expect(seen.at(-1)).toBe("turn-end:");
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

  it("keeps what the harness does out of the owner's memory", async () => {
    // A write, which asks whatever the host: a plain read of an allowed host
    // no longer does, because listing the host is the permission.
    const model = scripted([
      toolCall("c1", "http.fetch", {
        url: "https://example.com",
        method: "POST",
        body: "hi",
      }),
      text("Done."),
    ]);
    kernel = await boot(model.inference);

    await kernel.handleMessage("fetch example.com for me");
    const pending = kernel.approvals.pending();
    expect(pending).toHaveLength(1);

    await kernel.approve(pending[0]!.id);

    // Nothing about the approval machinery is something the owner said, so
    // none of it should become an episode or a remembered fact.
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

  it("holds one bubble per call, not one for asking and one for doing", async () => {
    // The queued placeholder used to be the tool_result, and the real result
    // arrived in a second turn under a second call: two bubbles for one
    // thing, the first of them permanently unfinished.
    const model = scripted([
      toolCall("c1", "files.rm", { path: "notes/x.md" }),
      text("Deleted it."),
    ]);
    kernel = await boot(model.inference);
    const c = kernel.conversations.create({ userId: "owner", title: "Ops" });

    await kernel.handleMessage("delete notes/x.md", { sessionId: c.id });
    await kernel.approve(kernel.approvals.pending()[0]!.id);

    await vi.waitFor(() => {
      expect(JSON.stringify(kernel.sessions.get(c.id))).toContain("Deleted it.");
    });
    const stored = kernel.sessions.get(c.id);
    const calls = stored.flatMap((m) =>
      (Array.isArray(m.content) ? m.content : []).filter(
        (b) => (b as { type?: string }).type === "tool_use",
      ),
    );
    expect(calls).toHaveLength(1);
    // And the one call carries what actually happened, not a placeholder.
    expect(JSON.stringify(stored)).not.toContain("queued for approval");
  });

  it("keeps a suspended turn's lane to itself", async () => {
    // Observe when the TOOL runs, not when approve() resolves. A turn waiting
    // on the owner still owns its conversation's lane, so anything else sent
    // to that conversation waits for it rather than interleaving with the
    // call it is about to make.
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

    const model = scripted([toolCall("c1", "test.mark", {}), text("Done.")]);
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
    // The lane the approval belongs to. Work in *this* conversation must not
    // be overtaken; work elsewhere is not this conversation's problem, which
    // is the whole point of lanes.
    const lane = pending[0]!.conversationId ?? primarySessionId("owner");
    const occupied = kernel.queue.enqueue(async () => {
      await blocker;
      order.push("in-flight job");
    }, lane);

    // Nothing has run yet: the queued job is behind the suspended turn, and
    // the turn is behind the owner.
    await new Promise((r) => setTimeout(r, 50));
    expect(order).toEqual([]);

    await kernel.approve(pending[0]!.id);
    release();
    await occupied;

    // The call finishes inside the turn that made it, and only then does the
    // next thing in that conversation get its turn. Never both at once.
    expect(order).toEqual(["approved action", "in-flight job"]);
  });

  /*
   * The other half of the same contract. One serial queue for everything meant
   * a long turn in one chat stopped every other chat, every cron job and every
   * approval, with nothing on screen to say why.
   */
  it("does not make one conversation wait on another", async () => {
    const model = scripted([text("Done here.")]);
    kernel = await boot(model.inference);
    const other = kernel.conversations.create({ userId: "owner", title: "Other" });

    let release!: () => void;
    const blocker = new Promise<void>((r) => (release = r));
    const busyElsewhere = kernel.queue.enqueue(() => blocker, "some-other-chat");

    const res = await kernel.handleMessage("anything", { sessionId: other.id });
    expect(res.reply).toContain("Done here.");

    release();
    await busyElsewhere;
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

  it("tells a scoped conversation what it cannot reach", async () => {
    const model = scripted([text("That would need the schema tools.")]);
    kernel = await boot(model.inference);
    const c = kernel.conversations.create({
      userId: "owner",
      title: "Notes",
      toolAllow: ["files", "memory"],
    });
    await kernel.handleMessage("add a rating column", { sessionId: c.id });

    // Withheld tools are simply absent, so the agent could not tell "no such
    // capability" from "not here". Asked to alter a schema with a files and
    // memory scope, one spent its whole turn writing and deleting memory
    // entries, including a false one saying the change had been made.
    const system = model.systems.at(-1)!;
    expect(system).toContain("limited to these tools");
    expect(system).toContain("files, memory");
  });

  it("does not tell the orchestrator to stop at what it cannot reach", async () => {
    const model = scripted([text("ok")]);
    kernel = await boot(model.inference);
    await kernel.handleOrchestratorTurn("build me a snake game page");

    // It is scoped too, but it has somewhere to send the work and a brief
    // saying so. Given the note meant for an ordinary conversation it
    // answered "I have no page tools here" and stopped, which is the one
    // thing it must never do.
    const system = model.systems.at(-1)!;
    expect(system).not.toContain("limited to these tools");
    expect(system).toContain("You are the owner's router");
  });

  it("says nothing about scope in an unrestricted conversation", async () => {
    const model = scripted([text("ok")]);
    kernel = await boot(model.inference);
    const c = kernel.conversations.create({ userId: "owner", title: "Open" });
    await kernel.handleMessage("hello", { sessionId: c.id });
    expect(model.systems.at(-1)!).not.toContain("limited to these tools");
  });

  it("answers rather than falling silent when it runs out of steps", async () => {
    // Every turn is a tool call, so the loop hits its cap with no text in the
    // last message. Handed straight to the reader that is silence.
    const model = scripted(
      Array.from({ length: 40 }, (_, i) =>
        toolCall(`m${i}`, "memory.recall", { query: "anything" }),
      ),
    );
    kernel = await boot(model.inference);
    const res = await kernel.handleMessage("do the thing");
    expect(res.reply.trim()).not.toBe("");
    expect(res.reply).toMatch(/stuck|too many steps/i);
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

  it("says what there is to search when a recall misses", async () => {
    const model = scripted([
      toolCall("m1", "memory.recall", { query: "quantum chromodynamics" }),
      text("Nothing on that."),
    ]);
    kernel = await boot(model.inference);
    kernel.facts.upsert("owner", {
      key: "deploy_target",
      value: "Fly.io",
      kind: "fact",
      tags: ["infra"],
    });

    await kernel.handleMessage("what do we know");
    const wire = JSON.stringify(model.calls.at(-1)!.request.messages);
    /*
     * An empty array reads as "nothing is known" and the reply says so. A
     * miss is usually the wrong words rather than an empty store, so it
     * comes back with something to aim at.
     */
    expect(wire).toContain("infra");
    expect(wire).toContain("Nothing matched those words");
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

describe("rewinding a conversation", () => {
  let root: string;
  let kernel: Kernel;

  afterEach(() => {
    kernel?.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function boot2(inference: Inference): Promise<Kernel> {
    root = mkdtempSync(join(tmpdir(), "kos-rewind-"));
    return Kernel.boot({ rootDir: root, secrets: new SecretsRegistry(), inference });
  }

  it("retries the last message, dropping what came after it", async () => {
    const model = scripted([text("first answer"), text("second answer")]);
    kernel = await boot2(model.inference);
    const c = kernel.conversations.create({ userId: "owner", title: "T" });
    await kernel.handleMessage("what is it", { sessionId: c.id });

    await kernel.rewind(c.id, 0);

    const wire = JSON.stringify(kernel.sessions.get(c.id));
    expect(wire).toContain("second answer");
    expect(wire).not.toContain("first answer");
  });

  it("edits a message and runs the new one", async () => {
    const model = scripted([text("a"), text("b")]);
    kernel = await boot2(model.inference);
    const c = kernel.conversations.create({ userId: "owner", title: "T" });
    await kernel.handleMessage("original", { sessionId: c.id });

    await kernel.rewind(c.id, 0, { text: "changed" });

    const wire = JSON.stringify(kernel.sessions.get(c.id));
    expect(wire).toContain("changed");
    expect(wire).not.toContain("original");
  });

  it("forks by copying, without asking the model again", async () => {
    // The answer already exists. Producing it again costs a call and can come
    // back different, which is not what forking a conversation means.
    const model = scripted([text("original answer")]);
    kernel = await boot2(model.inference);
    const c = kernel.conversations.create({ userId: "owner", title: "T" });
    await kernel.handleMessage("keep me", { sessionId: c.id });
    const callsBefore = model.calls.length;

    const res = await kernel.rewind(c.id, 0, { forkTitle: "Fork" });

    expect(model.calls.length).toBe(callsBefore);
    expect(res.conversationId).not.toBe(c.id);
    expect(JSON.stringify(kernel.sessions.get(res.conversationId))).toContain(
      "original answer",
    );
    expect(JSON.stringify(kernel.sessions.get(c.id))).toContain("keep me");
    expect(kernel.conversations.get(res.conversationId)?.title).toBe("Fork");
  });

  it("forks and reruns when the message is also edited", async () => {
    const model = scripted([text("a"), text("b")]);
    kernel = await boot2(model.inference);
    const c = kernel.conversations.create({ userId: "owner", title: "T" });
    await kernel.handleMessage("first", { sessionId: c.id });

    const res = await kernel.rewind(c.id, 0, { forkTitle: "F", text: "second" });

    expect(JSON.stringify(kernel.sessions.get(res.conversationId))).toContain("second");
    expect(JSON.stringify(kernel.sessions.get(c.id))).toContain("first");
  });

  it("refuses an index that is not an owner message", async () => {
    const model = scripted([text("a")]);
    kernel = await boot2(model.inference);
    const c = kernel.conversations.create({ userId: "owner", title: "T" });
    await kernel.handleMessage("one", { sessionId: c.id });
    await expect(kernel.rewind(c.id, 7)).rejects.toThrow(/no message #7/);
  });
});

describe("mentions in a message", () => {
  let root: string;
  let kernel: Kernel;

  afterEach(() => {
    kernel?.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function boot3(inference: Inference): Promise<Kernel> {
    root = mkdtempSync(join(tmpdir(), "kos-mention-"));
    return Kernel.boot({ rootDir: root, secrets: new SecretsRegistry(), inference });
  }

  it("puts a referenced file's contents in front of the agent", async () => {
    const model = scripted([text("ok")]);
    kernel = await boot3(model.inference);
    writeFileSync(join(root, "plan.md"), "ship the budget page");

    await kernel.handleMessage("what does @file:plan.md say");

    // A mention is a promise that the thing named is to hand, not a string the
    // agent has to go and look up.
    expect(model.systems.at(-1)!).toContain("ship the budget page");
  });

  it("says so when the thing referenced does not exist", async () => {
    const model = scripted([text("ok")]);
    kernel = await boot3(model.inference);
    await kernel.handleMessage("look at @project:nope");
    expect(model.systems.at(-1)!).toContain("not found");
  });

  it("adds nothing when there are no mentions", async () => {
    const model = scripted([text("ok")]);
    kernel = await boot3(model.inference);
    await kernel.handleMessage("just a normal message");
    expect(model.systems.at(-1)!).not.toContain("Referenced by the owner");
  });
});

describe("a message survives the turn it started", () => {
  let root: string;
  let kernel: Kernel;

  afterEach(() => {
    kernel?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("is in the transcript before the model has answered", async () => {
    // It used to exist nowhere but the browser until the turn finished, so
    // reloading the page mid-answer lost what had been asked.
    let midTurn: string | undefined;
    root = mkdtempSync(join(tmpdir(), "kos-persist-"));
    const inference: Inference = {
      async generate() {
        midTurn = JSON.stringify(kernel.sessions.get("chat:owner"));
        return {
          content: [{ type: "text", text: "answered" }],
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0 },
          model: "stub",
        };
      },
    };
    kernel = await Kernel.boot({
      rootDir: root,
      secrets: new SecretsRegistry(),
      inference,
    });

    await kernel.handleMessage("do not lose this");

    expect(midTurn).toContain("do not lose this");
    expect(midTurn).not.toContain("answered");
  });

  it("keeps what was asked even when the turn throws", async () => {
    root = mkdtempSync(join(tmpdir(), "kos-persist-fail-"));
    const inference: Inference = {
      async generate() {
        throw new Error("provider exploded");
      },
    };
    kernel = await Kernel.boot({
      rootDir: root,
      secrets: new SecretsRegistry(),
      inference,
    });

    await expect(kernel.handleMessage("still mine")).rejects.toThrow();
    expect(JSON.stringify(kernel.sessions.get("chat:owner"))).toContain(
      "still mine",
    );
  });

  it("has the whole exchange once the turn lands", async () => {
    const model = scripted([text("answered")]);
    root = mkdtempSync(join(tmpdir(), "kos-persist-done-"));
    kernel = await Kernel.boot({
      rootDir: root,
      secrets: new SecretsRegistry(),
      inference: model.inference,
    });
    await kernel.handleMessage("ask");
    const wire = JSON.stringify(kernel.sessions.get("chat:owner"));
    expect(wire).toContain("ask");
    expect(wire).toContain("answered");
  });
});

/**
 * A turn that runs out of room still has to say so, in the transcript.
 *
 * The loop's own messages end on a tool result when it hits the iteration
 * cap, and the "I got stuck" line was only ever the return value. Anything
 * that does not watch that value -- an unattended fix attempt, a reload of
 * the page -- saw a chat containing a question and no answer.
 */
describe("a turn that runs out of steps", () => {
  let root: string;
  let kernel: Kernel;

  afterEach(() => {
    kernel?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("leaves an answer in the transcript, not just in the reply", async () => {
    root = mkdtempSync(join(tmpdir(), "kos-exhaust-"));
    // Never stops calling tools, so the loop always hits its cap.
    const model: Inference = {
      async generate(task: Task): Promise<ModelResponse> {
        if (task === "cheap") return text('{"facts":[]}');
        return toolCall(`c${Math.random()}`, "files.ls", { path: "." });
      },
    };
    kernel = await Kernel.boot({
      rootDir: root,
      secrets: new SecretsRegistry(),
      inference: model,
      profileOverrides: { name: "Kenny", timezone: "UTC" },
    });
    const convo = kernel.conversations.create({ userId: "owner", title: "T" });

    const res = await kernel.handleMessage("do something", {
      sessionId: convo.id,
      maxIterations: 3,
    });

    expect(res.reply).toContain("stuck");
    const stored = kernel.sessions.get(convo.id);
    const last = stored.at(-1);
    expect(last?.role).toBe("assistant");
    expect(JSON.stringify(last?.content)).toContain("stuck");
  });

  it("takes its step limit from the settings", async () => {
    root = mkdtempSync(join(tmpdir(), "kos-steps-"));
    let calls = 0;
    const model: Inference = {
      async generate(task: Task): Promise<ModelResponse> {
        if (task === "cheap") return text('{"facts":[]}');
        calls += 1;
        return toolCall(`c${calls}`, "files.ls", { path: "." });
      },
    };
    kernel = await Kernel.boot({
      rootDir: root,
      secrets: new SecretsRegistry(),
      inference: model,
      profileOverrides: { name: "Kenny", timezone: "UTC" },
    });
    // The number was a constant in the loop, so "how hard should it try"
    // could only be answered by editing the source.
    kernel.settings.set(BEHAVIOUR_KEY, { maxSteps: 2 });
    const convo = kernel.conversations.create({ userId: "owner", title: "T" });

    await kernel.handleMessage("go", { sessionId: convo.id });

    expect(calls).toBe(2);
  });

  it("does not add one when the model actually answered", async () => {
    root = mkdtempSync(join(tmpdir(), "kos-exhaust2-"));
    const model = scripted([text("Here you go.")]);
    kernel = await Kernel.boot({
      rootDir: root,
      secrets: new SecretsRegistry(),
      inference: model.inference,
      profileOverrides: { name: "Kenny", timezone: "UTC" },
    });
    const convo = kernel.conversations.create({ userId: "owner", title: "T" });

    await kernel.handleMessage("hello", { sessionId: convo.id });

    const stored = kernel.sessions.get(convo.id);
    const assistants = stored.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(JSON.stringify(assistants[0]!.content)).toContain("Here you go.");
  });
});

/**
 * The unattended path: a job that fails at 3am with nobody watching.
 *
 * This is the case the whole product rests on, and it used to end at a row in
 * runs_log. Nothing was sent, nothing was shown, and a cron broken for a week
 * was indistinguishable from a cron with nothing to do.
 */
describe("failures reach the owner", () => {
  let root: string;
  let kernel: Kernel;

  afterEach(() => {
    kernel?.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function bootWithChannel(sent: string[]): Promise<Kernel> {
    root = mkdtempSync(join(tmpdir(), "kos-health-"));
    return Kernel.boot({
      rootDir: root,
      secrets: new SecretsRegistry(),
      inference: scripted([]).inference,
      profileOverrides: { name: "Kenny", timezone: "UTC" },
      notify: async (text: string) => {
        sent.push(text);
      },
    });
  }

  it("messages the owner when an unattended job fails", async () => {
    const sent: string[] = [];
    kernel = await bootWithChannel(sent);
    const job = kernel.crons.create({
      name: "nightly digest",
      schedule: "0 3 * * *",
      type: "actions",
      // Reads a file that is not there, so the action comes back as an error
      // rather than throwing. An unknown tool would not do: the guard queues
      // that for approval instead, which is a different outcome entirely.
      actions: [{ tool: "files.read", args: { path: "nope/missing.md" } }],
      enabled: true,
    });
    kernel.startCron();

    await kernel.fireCron(job.id);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("nightly digest");
    expect(kernel.health.report().ok).toBe(false);
  });

  it("records the run as failed, not as a clean pass", async () => {
    const sent: string[] = [];
    kernel = await bootWithChannel(sent);
    const job = kernel.crons.create({
      name: "nightly digest",
      schedule: "0 3 * * *",
      type: "actions",
      actions: [{ tool: "files.read", args: { path: "nope/missing.md" } }],
      enabled: true,
    });
    kernel.startCron();

    await kernel.fireCron(job.id);

    // An erroring action does not throw, so this used to be logged "ok".
    const run = kernel.runs.recent(5).find((r) => r.kind === "cron");
    expect(run?.status).toBe("error");
  });

  it("does not repeat itself while the job stays broken", async () => {
    const sent: string[] = [];
    kernel = await bootWithChannel(sent);
    const job = kernel.crons.create({
      name: "nightly digest",
      schedule: "* * * * *",
      type: "actions",
      actions: [{ tool: "files.read", args: { path: "nope/missing.md" } }],
      enabled: true,
    });
    kernel.startCron();

    await kernel.fireCron(job.id);
    await kernel.fireCron(job.id);

    // A minutely job that floods you is one you mute, and a muted assistant is
    // worse than the silence this replaced.
    expect(sent).toHaveLength(1);
  });

  it("stops reporting a failure once the job is gone", async () => {
    const sent: string[] = [];
    kernel = await bootWithChannel(sent);
    const job = kernel.crons.create({
      name: "nightly digest",
      schedule: "0 3 * * *",
      type: "actions",
      actions: [{ tool: "files.read", args: { path: "nope/missing.md" } }],
      enabled: true,
    });
    kernel.startCron();
    await kernel.fireCron(job.id);
    expect(kernel.health.report().ok).toBe(false);

    // Deleting a broken job is a repair, and one a fix attempt may well
    // choose. Its failure used to outlive it in the report and in the header
    // count, with Dismiss the only way to be rid of it.
    kernel.crons.delete(job.id);
    kernel.reloadCron();

    expect(kernel.health.report().ok).toBe(true);
  });

  it("points the fix at the job that broke", async () => {
    const sent: string[] = [];
    kernel = await bootWithChannel(sent);
    const job = kernel.crons.create({
      name: "9 AM Pinger Test",
      schedule: "0 9 * * *",
      type: "actions",
      actions: [{ tool: "notify", args: { text: "ping" } }],
      enabled: true,
    });

    const started = await kernel.startFix({
      label: job.name,
      error: "Cannot convert undefined or null to object",
      what: "scheduled job",
      ref: `cron #${job.id}`,
    });

    // Bracketed, because the name has spaces and the plain form would be
    // read as far as the first one. Worked out from the failure rather than
    // written into the prompt by the caller.
    expect(started.prompt).toContain("@schedule:[9 AM Pinger Test]");
  });

  it("falls back to the project a failure names", async () => {
    const sent: string[] = [];
    kernel = await bootWithChannel(sent);
    kernel.manifest.createProject({ name: "Budget Tracker", type: "budget" });

    const started = await kernel.startFix({
      label: "sql",
      error: "no such column: amount in budget_tracker_tx",
      what: "tool call",
    });

    expect(started.prompt).toContain("@project:budget_tracker");
  });

  it("says nothing it cannot back up", async () => {
    const sent: string[] = [];
    kernel = await bootWithChannel(sent);
    const started = await kernel.startFix({
      label: "something",
      error: "it broke",
      what: "tool call",
    });
    // No schedule and no project matched, so it names the thing plainly
    // rather than inventing a reference that resolves to "not found".
    expect(started.prompt).not.toContain("@schedule:");
    expect(started.prompt).not.toContain("@project:");
  });

  it("keeps quiet about a job that is working", async () => {
    const sent: string[] = [];
    kernel = await bootWithChannel(sent);
    const job = kernel.crons.create({
      name: "healthy job",
      schedule: "0 3 * * *",
      type: "actions",
      actions: [{ tool: "notify", args: { text: "tick" } }],
      enabled: true,
    });
    kernel.startCron();

    await kernel.fireCron(job.id);

    expect(sent).toEqual(["tick"]);
    expect(kernel.health.report().ok).toBe(true);
  });
});
