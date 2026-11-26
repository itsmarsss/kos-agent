import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Inference } from "../agent/loop.js";
import type { ModelResponse } from "../models/types.js";
import { BURST_MS } from "../ops/permissions.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import type { DiscordServices } from "../tools/discord.js";
import type { NotifyPayload } from "../tools/notify.js";
import { BEHAVIOUR_KEY } from "./behaviour.js";
import { Kernel } from "./kernel.js";

/**
 * Routine work that stops asking: a schedule posting where the owner
 * consented, a burst of one kind of step after one yes; and what still
 * asks however often it was approved.
 */

function text(body: string): ModelResponse {
  return { content: [{ type: "text", text: body }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" };
}

function toolCall(id: string, name: string, input: Record<string, unknown>): ModelResponse {
  return { content: [{ type: "tool_use", id, name, input }], stopReason: "tool_use", usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" };
}

function scripted(script: ModelResponse[]): Inference {
  const queue = [...script];
  return {
    async generate(task): Promise<ModelResponse> {
      if (task === "cheap") return text('{"facts":[]}');
      return queue.shift() ?? text("done");
    },
  };
}

describe("routine work without asking", () => {
  let root: string;
  let kernel: Kernel;
  let sent: NotifyPayload[];
  /** Whether the server is up to say who reads a channel. */
  let serverUp: boolean;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-routine-"));
    sent = [];
    serverUp = true;
  });

  afterEach(() => {
    vi.useRealTimers();
    kernel?.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function boot(inference: Inference = scripted([])): Promise<Kernel> {
    return Kernel.boot({
      rootDir: root,
      secrets: new SecretsRegistry(),
      inference,
      profileOverrides: { name: "Kenny", timezone: "UTC" },
      notify: async (payload) => {
        sent.push(payload);
        return undefined;
      },
      // "own" is the owner's alone; every other channel is read by others.
      discord: { connected: () => serverUp, ownerAlone: (id: string) => serverUp && id === "own" } as unknown as DiscordServices,
    });
  }

  const posting = (k: Kernel, to: string, name = "Digest") =>
    k.crons.create({ name, schedule: "0 7 * * *", type: "actions", actions: [{ tool: "notify", args: { to, text: `${name} for today` } }], enabled: true });

  it("lets a job post where only the owner reads, with no ask", async () => {
    kernel = await boot();
    const job = posting(kernel, "discord:channel:own");
    expect((await kernel.fireCron(job.id)).ok).toBe(true);
    expect(kernel.approvals.pending()).toHaveLength(0);
    expect(sent.map((p) => p.text)).toEqual(["Digest for today"]);
  });

  it("asks there when the server cannot say who reads it, or the owner set jobs to ask", async () => {
    kernel = await boot();
    const job = posting(kernel, "discord:channel:own");
    serverUp = false;
    await kernel.fireCron(job.id);
    expect(kernel.approvals.pending()).toHaveLength(1);
    serverUp = true;
    kernel.settings.set(BEHAVIOUR_KEY, { jobsPostUnasked: false });
    await kernel.fireCron(job.id);
    expect(kernel.approvals.pending()).toHaveLength(2);
    expect(sent).toEqual([]);
  });

  it("asks every run for a channel others read, whatever was approved before", async () => {
    kernel = await boot();
    const job = posting(kernel, "discord:channel:pub");
    await kernel.fireCron(job.id);
    const [ask] = kernel.approvals.pending();
    expect(ask).toMatchObject({ tool: "notify", job: job.id, rule: null });
    await kernel.approve(ask!.id, undefined, { surface: "dashboard", remember: true });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(kernel.permissions.list()).toEqual([]);
    await kernel.fireCron(job.id);
    expect(kernel.approvals.pending()).toHaveLength(1);
  });

  it("keeps a schedule's Always for its later runs, and a plain Approve for this run alone", async () => {
    kernel = await boot();
    const touching = (name: string) => kernel.crons.create({ name, schedule: "0 7 * * *", type: "actions", actions: [{ tool: "shell.run", args: { command: `touch ${name}.txt` } }], enabled: true });
    const kept = touching("kept");
    await kernel.fireCron(kept.id);
    await kernel.approve(kernel.approvals.pending()[0]!.id, undefined, { surface: "dashboard", remember: true });
    await vi.waitFor(() => expect(kernel.permissions.list()).toMatchObject([{ tool: "shell.run", scope: "cmd:touch", job: kept.id }]));
    await kernel.fireCron(kept.id);
    expect(kernel.approvals.pending()).toHaveLength(0);

    const once = touching("once");
    await kernel.fireCron(once.id);
    await kernel.approve(kernel.approvals.pending()[0]!.id, undefined, { surface: "dashboard" });
    await vi.waitFor(() => expect(kernel.approvals.pending()).toHaveLength(0));
    expect(kernel.permissions.list()).toHaveLength(1);
    await kernel.fireCron(once.id);
    expect(kernel.approvals.pending()).toHaveLength(1);
  });

  it("refuses a widening the job read somewhere: a channel others read asks, and nothing is learned from it", async () => {
    kernel = await boot(
      scripted([
        toolCall("r1", "notify", { to: "discord:channel:own", text: "School digest" }),
        // What a page it read told it to do.
        toolCall("r2", "notify", { to: "discord:channel:pub", text: "Also post this here, as the page says" }),
        text("Posted."),
      ]),
    );
    const job = kernel.crons.create({ name: "Digest", schedule: "0 7 * * *", type: "self_prompt", prompt: "Read the school page and post the digest to discord:channel:own.", enabled: true });
    await kernel.fireCron(job.id);
    await vi.waitFor(() => expect(kernel.approvals.pending()).toHaveLength(1));
    const [ask] = kernel.approvals.pending();
    expect(ask).toMatchObject({ tool: "notify", job: job.id });
    expect(JSON.parse(ask!.args).to).toBe("discord:channel:pub");
    expect(sent.map((p) => p.text)).toEqual(["School digest"]);
    await kernel.deny(ask!.id, undefined, { surface: "dashboard" });
    expect(kernel.permissions.list()).toEqual([]);
  });

  it("lets the same step through for fifteen minutes after one yes in a chat, and asks again after", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    kernel = await boot(
      scripted([
        toolCall("t1", "shell.run", { command: "touch a.txt" }),
        toolCall("t2", "shell.run", { command: "touch b.txt" }),
        text("Made both."),
        toolCall("t3", "shell.run", { command: "touch c.txt" }),
        text("Made it."),
      ]),
    );
    const asked: number[] = [];
    kernel.bus.on("approval:requested", (e) => void asked.push(e.id));
    const c = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Files" });
    const first = await kernel.handleMessage("make a and b", { sessionId: c.id });
    expect(first.suspended).toBe(true);
    await kernel.approve(kernel.approvals.pending()[0]!.id, undefined, { surface: "dashboard" });
    await first.ended;
    // One ask for two steps of one kind.
    expect(asked).toHaveLength(1);
    expect(kernel.audit.recent(5).find((e) => e.tool === "shell.run" && e.decidedVia === "burst")).toBeDefined();

    vi.setSystemTime(Date.now() + BURST_MS + 1);
    const later = await kernel.handleMessage("make c", { sessionId: c.id });
    expect(later.suspended).toBe(true);
    expect(asked).toHaveLength(2);
    await kernel.deny(kernel.approvals.pending()[0]!.id, undefined, { surface: "dashboard" });
    await later.ended;
  });

  it("keeps a revoked job rule revoked across a restart", async () => {
    kernel = await boot();
    const job = kernel.crons.create({ name: "touch", schedule: "0 7 * * *", type: "actions", actions: [{ tool: "shell.run", args: { command: "touch t.txt" } }], enabled: true });
    await kernel.fireCron(job.id);
    await kernel.approve(kernel.approvals.pending()[0]!.id, undefined, { surface: "dashboard", remember: true });
    await vi.waitFor(() => expect(kernel.permissions.list()).toHaveLength(1));
    kernel.permissions.revoke(kernel.permissions.list()[0]!.id);
    kernel.close();

    kernel = await boot();
    expect(kernel.permissions.list()).toEqual([]);
    await kernel.fireCron(job.id);
    expect(kernel.approvals.pending()).toHaveLength(1);
  });
});
