import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Inference } from "../agent/loop.js";
import type { GenerateRequest, ModelResponse } from "../models/types.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Kernel } from "./kernel.js";
import { isKernelTable } from "../tools/fence.js";
import { SurfaceDownError, type NotifyPayload } from "../tools/notify.js";
import { toPdf } from "../tools/pdf.js";
import { bodyHexOf } from "@kos/shared";
import { primarySessionId } from "./session.js";

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

  async function boot(
    inference: Inference,
    notify?: (payload: { text: string }) => Promise<void>,
  ): Promise<Kernel> {
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
      async (payload) => {
        sent.push(payload.text);
      },
    );
    const res = await kernel.handleMessage("save a note");
    expect(res.reply).toBe("wrote the file");
    // the safe tool ran and was audited
    expect(kernel.audit.recent().some((a) => a.tool === "files.write")).toBe(true);
  });

  it("leaves a message for the owner on the dashboard while the surface is down", async () => {
    const step = (name: string, input: Record<string, unknown>): ModelResponse => ({
      content: [{ type: "tool_use", id: name, name: "notify", input }],
      stopReason: "tool_use",
      usage: { inputTokens: 0, outputTokens: 0 },
      model: "stub",
    });
    const done: ModelResponse = { content: [{ type: "text", text: "told you" }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" };
    // Discord is wired but mid-login: the host's notify says so, and the
    // message used to come back to the agent as a tool error, which marked
    // the job failing and had the caretaker open a fix chat for nothing.
    kernel = await boot(stubInference([step("n1", { text: "the oven is done" }), done]), async () => {
      throw new SurfaceDownError("discord", []);
    });
    const primary = primarySessionId(kernel.profile.ownerId);
    const before = kernel.sessions.get(primary).length;
    const c = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Kitchen" });
    await kernel.handleMessage("tell me when the oven is done", { sessionId: c.id });
    const notified = kernel.audit.recent().filter((a) => a.tool === "notify");
    const owner = notified.find((a) => a.args.includes("the oven is done"));
    expect(owner).toMatchObject({ isError: false });
    expect(owner!.result).toContain("discord is not connected right now");
    expect(JSON.stringify(kernel.sessions.get(primary).slice(before))).toContain("the oven is done");
    // A channel has no dashboard to fall back to. Called straight, since in
    // a turn speaking in public waits on the owner first.
    const room = await kernel.registry.execute("notify", { text: "hello room", to: "channel:123" });
    expect(room.isError).toBe(true);
    expect(room.content).toContain("is not connected right now");
  });

  it("tags a blob's message with the blob's name and colour, and leaves KOS's own untagged", async () => {
    const step = (name: string, text: string): ModelResponse => ({
      content: [{ type: "tool_use", id: name, name: "notify", input: { text } }],
      stopReason: "tool_use",
      usage: { inputTokens: 0, outputTokens: 0 },
      model: "stub",
    });
    const done: ModelResponse = { content: [{ type: "text", text: "sent" }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" };
    const seen: NotifyPayload[] = [];
    kernel = await boot(stubInference([step("n1", "the day is done"), done, step("n2", "hi from kos"), done]), async (payload) => {
      seen.push(payload as NotifyPayload);
    });
    // The surface is told who is speaking, so a blob's message does not read as KOS's.
    kernel.roles.write({ name: "recap", description: "Sums up the day", brief: "You recap.", memory: "own" });
    await kernel.handleMessage("send it", { sessionId: kernel.ensureAgentConversation("recap").id });
    expect(seen[0]).toMatchObject({ text: "the day is done", from: { name: "Recap", colour: bodyHexOf("recap") } });
    // The blob's face rides along as a picture, and is kept in its folder for anything to reuse.
    expect(Buffer.from(seen[0]!.from!.avatar!, "base64").subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(existsSync(join(root, "blobs", "recap", "face.png"))).toBe(true);
    expect(readFileSync(join(root, "blobs", "recap", "face.svg"), "utf8")).toContain("<svg");
    const c = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Kitchen" });
    await kernel.handleMessage("say hi", { sessionId: c.id });
    expect(seen[1]).toMatchObject({ text: "hi from kos" });
    expect(seen[1]).not.toHaveProperty("from");
  });

  it("names who is asking for an approval by the chat the owner knows", async () => {
    kernel = await boot(stubInference([]));
    kernel.roles.write({ name: "recap", description: "Sums up the day", brief: "You recap.", memory: "own" });
    const thread = kernel.ensureAgentConversation("recap");
    const chat = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Kitchen" });
    expect(kernel.askerOf(thread.id)).toEqual({ name: "Recap", conversationId: thread.id });
    expect(kernel.askerOf(chat.id)).toEqual({ name: "Kitchen", conversationId: chat.id });
    expect(kernel.askerOf(`orchestrator:${kernel.profile.ownerId}`)).toEqual({ name: "KOS", conversationId: `orchestrator:${kernel.profile.ownerId}` });
    expect(kernel.askerOf(null)).toBeUndefined();
    expect(kernel.askerOf("nope")).toBeUndefined();
  });

  it("runs a server channel's words where the channel is bound, and lays the channels out from what exists", async () => {
    const answer = (text: string): ModelResponse => ({ content: [{ type: "text", text }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" });
    kernel = await boot(stubInference([answer("In the garden."), answer("In the thread."), answer("Recap here."), answer("KOS here.")]));
    const garden = kernel.standUpProject({ name: "My Garden", type: "tracker" });
    kernel.roles.write({ name: "recap", description: "Sums up the day", brief: "You recap.", memory: "own" });
    // The project's channel runs its orchestrator.
    const inProject = await kernel.handleChannelTurn({ text: "what's growing", userId: "owner", channel: "discord", conversationId: `project:${garden.slug}` });
    expect(inProject).toMatchObject({ conversationId: `project:${garden.slug}`, reply: "In the garden." });
    expect(JSON.stringify(kernel.sessions.get(`project:${garden.slug}`))).toContain("what's growing");
    // A thread under it is a new chat of the project, titled as the thread, kept for the next message.
    const inThread = await kernel.handleChannelTurn({ text: "seeds?", userId: "owner", channel: "discord", conversationId: "discord:thread:t9", newIn: { projectSlug: garden.slug, title: "Seeds" } });
    expect(inThread.conversationId).toBe("discord:thread:t9");
    expect(kernel.conversations.get("discord:thread:t9")).toMatchObject({ title: "Seeds", projectSlug: garden.slug, channel: "discord" });
    // A blob's channel runs the blob's own thread, and the answer is tagged as its own.
    const inBlob = await kernel.handleChannelTurn({ text: "what did I do", userId: "owner", channel: "discord", conversationId: "agent:recap" });
    expect(inBlob).toMatchObject({ conversationId: "agent:recap", reply: "Recap here.", from: { name: "Recap" } });
    // KOS's own channel is the root.
    const atRoot = await kernel.handleChannelTurn({ text: "hello", userId: "owner", channel: "discord", conversationId: "orchestrator:owner" });
    expect(atRoot).toMatchObject({ conversationId: "orchestrator:owner", reply: "KOS here." });
    expect(atRoot).not.toHaveProperty("from");
    // A channel bound to something gone is said so, not answered as nobody.
    await expect(kernel.handleChannelTurn({ text: "x", userId: "owner", channel: "discord", conversationId: "agent:nobody" })).rejects.toThrow(/no blob called nobody/);
    await expect(kernel.handleChannelTurn({ text: "x", userId: "owner", channel: "discord", conversationId: "project:gone" })).rejects.toThrow(/no project called gone/);
    // The plan: KOS, approvals, each project (the workspace's own included), each blob, with the binding in the topic.
    const plan = kernel.surfaceChannels();
    expect(plan.slice(0, 2)).toEqual([
      { key: "orchestrator:owner", name: "kos", topic: "kos:orchestrator:owner · KOS", category: "KOS", audience: "owner", fixed: true },
      { key: "needs-you", name: "needs-you", topic: "kos:needs-you · Approvals", category: "KOS", audience: "owner", fixed: true },
    ]);
    // Blobs under Blobs; projects under Projects, each with a thread per chat in it (the thread chat made above).
    expect(plan).toEqual(expect.arrayContaining([{ key: "agent:recap", name: "recap", topic: "kos:agent:recap · Recap", category: "Blobs", audience: "owner" }]));
    const gardenPlan = plan.find((c) => c.key === `project:${garden.slug}`)!;
    expect(gardenPlan).toMatchObject({ name: "my-garden", topic: `kos:project:${garden.slug} · My Garden`, category: "Projects", audience: "owner" });
    expect(gardenPlan.threads).toEqual([{ conversationId: "discord:thread:t9", title: "Seeds" }]);
    // A thread KOS made is remembered as its chat.
    kernel.bindThread("t42", "discord:thread:t9");
    expect(kernel.threadBindings()).toEqual({ t42: "discord:thread:t9" });
    expect(plan.every((c) => /^[a-z0-9-]+$/.test(c.name))).toBe(true);
    // Everything is the owner's alone until they say otherwise, one channel at a time; KOS's own and the approvals always.
    expect(plan.every((c) => c.audience === "owner")).toBe(true);
    expect(plan.filter((c) => c.fixed).map((c) => c.key)).toEqual(["orchestrator:owner", "needs-you"]);
    kernel.setChannelAudience(`project:${garden.slug}`, "everyone");
    expect(kernel.channelAudiences()).toEqual({ [`project:${garden.slug}`]: "everyone" });
    expect(kernel.surfaceChannels().find((c) => c.key === `project:${garden.slug}`)?.audience).toBe("everyone");
    kernel.setChannelAudience(`project:${garden.slug}`, "owner");
    expect(kernel.channelAudiences()).toEqual({});
  });

  it("tells the bus what each turn said, and where the words came in", async () => {
    const answer = (text: string): ModelResponse => ({ content: [{ type: "text", text }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" });
    kernel = await boot(stubInference([answer("Three things."), answer("From Discord.")]));
    const said: { conversationId: string; text: string; reply: string; origin: string; channel: string | null }[] = [];
    kernel.bus.on("turn:said", (e) => {
      said.push({ conversationId: e.conversationId, text: e.text, reply: e.reply, origin: e.origin, channel: e.channel });
    });
    const c = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Kitchen" });
    await kernel.handleMessage("what did I do?", { sessionId: c.id });
    expect(said).toEqual([{ conversationId: c.id, text: "what did I do?", reply: "Three things.", origin: "owner", channel: null }]);
    // A turn from a surface names the surface, so a mirror of the chat there does not repeat it.
    await kernel.handleChannelTurn({ text: "and now?", userId: "owner", channel: "discord", conversationId: c.id });
    expect(said[1]).toMatchObject({ conversationId: c.id, text: "and now?", reply: "From Discord.", channel: "discord" });
  });

  it("keeps what came with a message as files where the chat lives, tells the turn, and tells the mirror", async () => {
    const requests: GenerateRequest[] = [];
    const reply = (text: string): ModelResponse => ({ content: [{ type: "text", text }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" });
    kernel = await boot({
      async generate(_t, r) {
        requests.push(r);
        return reply("Kept.");
      },
    });
    const files: { conversationId: string; files: { name: string; path: string }[] }[] = [];
    kernel.bus.on("turn:said", (e) => {
      files.push({ conversationId: e.conversationId, files: e.files });
    });
    const png = Buffer.from("not really a png").toString("base64");
    // A root chat: the workspace's own uploads folder, as the file came.
    const c = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Receipts" });
    await kernel.handleMessage("can you access this", { sessionId: c.id, attachments: [{ name: "receipt.png", mediaType: "image/png", data: png }] });
    expect(readFileSync(join(root, "uploads", "receipt.png"), "base64")).toBe(png);
    expect(files.at(-1)).toEqual({ conversationId: c.id, files: [{ name: "receipt.png", path: "uploads/receipt.png" }] });
    // The model is told where, as a reference it can hand on.
    expect(JSON.stringify(requests.at(-1))).toContain("@file:uploads/receipt.png");
    // Sent again under the same name: kept beside, not over, the first.
    await kernel.handleMessage("and this", { sessionId: c.id, attachments: [{ name: "receipt.png", mediaType: "image/png", data: png }] });
    expect(files.at(-1)!.files).toEqual([{ name: "receipt.png", path: "uploads/receipt copy.png" }]);
    // A project's chat keeps them with the project; a blob's thread, in the blob's folder.
    const project = kernel.standUpProject({ name: "Garden", type: "notes" });
    await kernel.handleMessage("plan", { sessionId: project.conversationId, attachments: [{ name: "beds.pdf", mediaType: "application/pdf", data: toPdf([{ bed: "north" }], "Beds").toString("base64") }] });
    expect(files.at(-1)!.files).toEqual([{ name: "beds.pdf", path: `projects/${project.slug}/uploads/beds.pdf` }]);
    // The PDF itself is what is kept, not the text it was read as.
    expect(readFileSync(join(root, "projects", project.slug, "uploads", "beds.pdf")).subarray(0, 4).toString("ascii")).toBe("%PDF");
    kernel.roles.write({ name: "recap", description: "Sums up", brief: "You recap.", memory: "own" as const });
    const thread = kernel.ensureAgentConversation("recap");
    await kernel.handleMessage("file this", { sessionId: thread.id, attachments: [{ name: "../../notes.txt", mediaType: "text/plain", data: Buffer.from("hi").toString("base64") }] });
    // A name that tries to climb out is just a name.
    expect(files.at(-1)!.files).toEqual([{ name: "../../notes.txt", path: "blobs/recap/uploads/notes.txt" }]);
    expect(readFileSync(join(root, "blobs", "recap", "uploads", "notes.txt"), "utf8")).toBe("hi");
  });

  it("reads an attached PDF into the turn as the text it is", async () => {
    kernel = await boot(stubInference([]));
    const c = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Bills" });
    const pdf = toPdf([{ item: "kettle", price: "42" }], "Shopping").toString("base64");
    await kernel.handleMessage("what did I buy?", { sessionId: c.id, attachments: [{ name: "bill.pdf", mediaType: "application/pdf", data: pdf }] });
    // Recorded as a text file under its own name, so the model and the
    // transcript both see words rather than a refused attachment.
    const user = kernel.sessions.get(c.id).find((m) => m.role === "user")!;
    const file = (user.content as { type: string; name?: string; text?: string }[]).find((b) => b.type === "file");
    expect(file?.name).toBe("bill.pdf");
    expect(file?.text).toContain("kettle 42");
  });

  it("draws KOS's own face for the bot to wear, and again only when the look changes", async () => {
    kernel = await boot(stubInference([]));
    const first = kernel.faceToWear()!;
    expect(Buffer.from(first.png, "base64").subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(first.hash).toMatch(/^[0-9a-f]{16}$/);
    // Worn: nothing to do until the look changes.
    kernel.wearFace(first.hash);
    expect(kernel.faceToWear()).toBeUndefined();
    kernel.settings.set("kos.face", { colour: "#8b5cf6" });
    const next = kernel.faceToWear()!;
    expect(next.hash).not.toBe(first.hash);
    expect(next.png).not.toBe(first.png);
  });

  it("sends the owner a reporting blob's answer after each scheduled run, tagged as the blob's", async () => {
    const answer = (text: string): ModelResponse => ({ content: [{ type: "text", text }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" });
    const seen: NotifyPayload[] = [];
    kernel = await boot(stubInference([answer("Nothing changed today."), answer("Quiet again.")]), async (payload) => {
      seen.push(payload as NotifyPayload);
    });
    const role = { name: "recap", description: "Sums up the day", brief: "You recap.", memory: "own" as const, schedule: "0 18 * * *", prompt: "Recap.", report: "always" as const };
    kernel.roles.write(role);
    const thread = kernel.ensureAgentConversation("recap");
    const job = kernel.bindAgentSchedule("recap", role)!;
    await kernel.fireCron(job.id);
    expect(seen).toMatchObject([{ text: "Nothing changed today.", target: { kind: "owner" }, from: { name: "Recap", colour: bodyHexOf("recap") } }]);
    expect(JSON.stringify(kernel.sessions.get(thread.id))).toContain("Nothing changed today.");
    // Without report, the answer stays in the thread.
    kernel.roles.write({ ...role, report: undefined });
    await kernel.fireCron(job.id);
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(kernel.sessions.get(thread.id))).toContain("Quiet again.");
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

  it("queues an ask with what the model said just before it, from the same stream the dashboard watches", async () => {
    // Either engine streams text through the progress bus before the call
    // runs; the words since the last tool call ride with the ask.
    const script: ModelResponse[] = [
      { content: [{ type: "tool_use", id: "t1", name: "sql", input: { sql: "DELETE FROM x" } }], stopReason: "tool_use", usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" },
      { content: [{ type: "text", text: "queued it" }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" },
    ];
    const said = ["Those rows are the duplicates from Tuesday. ", "I'll remove them now."];
    kernel = await boot({
      async generate(_t, req: GenerateRequest): Promise<ModelResponse> {
        const next = script.shift()!;
        if (next.stopReason === "tool_use") for (const piece of said) req.onDelta?.({ kind: "text", text: piece });
        return next;
      },
    });
    await kernel.handleMessage("delete stuff");
    expect(kernel.approvals.pending()[0]?.why).toBe("Those rows are the duplicates from Tuesday. I'll remove them now.");
  });

  it("restarts only once no chat is mid-turn, and not at all when nothing would start it again", async () => {
    // Each turn waits until the test lets it go, so the host is busy on cue.
    const gates: (() => void)[] = [];
    const inference: Inference = {
      async generate(): Promise<ModelResponse> {
        await new Promise<void>((r) => gates.push(r));
        return { content: [{ type: "text", text: "done" }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" };
      },
    };
    root = mkdtempSync(join(tmpdir(), "kos-kernel-"));
    let restarted = 0;
    kernel = await Kernel.boot({
      rootDir: root,
      secrets: new SecretsRegistry(),
      inference,
      profileOverrides: { name: "Kenny", timezone: "UTC" },
      restart: async () => {
        restarted++;
      },
    });
    const turn = kernel.handleMessage("think about it");
    await vi.waitFor(() => expect(kernel.busyConversations()).toHaveLength(1));
    const asked = kernel.requestRestart();
    // The primary chat has no row of its own yet, so it is named by id.
    expect(asked).toMatchObject({ supported: true, pending: true, busy: ["chat:owner"] });
    expect(restarted).toBe(0);
    gates.shift()!();
    await turn;
    // The poll notices the host is idle and hands over; nothing is cut.
    await vi.waitFor(() => expect(restarted).toBe(1), { timeout: 5000 });
    expect(kernel.restartStatus()).toMatchObject({ pending: false, busy: [] });
    // Cancelled while the host is still busy, it does not go when the turn ends.
    const again = kernel.handleMessage("once more");
    await vi.waitFor(() => expect(kernel.busyConversations()).toHaveLength(1));
    expect(kernel.requestRestart().pending).toBe(true);
    expect(kernel.cancelRestart().pending).toBe(false);
    gates.shift()!();
    await again;
    await new Promise((r) => setTimeout(r, 2500));
    expect(restarted).toBe(1);
    // Two poll periods of real waiting, so under a full run it needs more
    // than the default five seconds.
  }, 15_000);

  it("lapses an ask nobody answered in a day, and tells the chat that asked", async () => {
    kernel = await boot({
      async generate(): Promise<ModelResponse> {
        return { content: [{ type: "text", text: "ok" }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" };
      },
    });
    const id = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Main" }).id;
    const old = kernel.approvals.enqueue({ tool: "shell.run", args: { command: "rm x" }, riskTier: "risky", conversationId: id });
    const fresh = kernel.approvals.enqueue({ tool: "shell.run", args: { command: "rm y" }, riskTier: "risky", conversationId: id });
    kernel.workspace.db.prepare(`UPDATE pending_actions SET requested_at = ? WHERE id = ?`).run(Date.now() - 25 * 3_600_000, old.id);
    expect(kernel.sweepExpiredApprovals().map((a) => a.id)).toEqual([old.id]);
    expect(kernel.approvals.pending().map((a) => a.id)).toEqual([fresh.id]);
    const said = JSON.stringify(kernel.sessions.get(id));
    expect(said).toContain(`#${old.id} (Run: rm x) lapsed: nobody decided within 24 hours, so nothing was done.`);
    expect(said).not.toContain(`#${fresh.id}`);
  });

  it("writes news into a chat after its turn rather than into the turn", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    kernel = await boot({
      async generate(): Promise<ModelResponse> {
        await gate;
        return { content: [{ type: "text", text: "Done." }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" };
      },
    });
    const chat = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Main" });
    const turn = kernel.handleMessage("go", { sessionId: chat.id });
    await vi.waitFor(() => expect(kernel.busyConversations()).toContain(chat.id));
    kernel.noteIn(chat.id, "Books answered: later.");
    expect(JSON.stringify(kernel.sessions.get(chat.id))).not.toContain("Books answered");
    release();
    await turn;
    const said = kernel.sessions.get(chat.id);
    expect(JSON.stringify(said)).toContain("Books answered: later.");
    // After the turn's own reply, as its own line.
    expect(JSON.stringify(said.at(-1))).toContain("Books answered: later.");
    expect(JSON.stringify(said.at(-2))).toContain("Done.");
    kernel.noteIn(chat.id, "Books answered: now.");
    expect(JSON.stringify(kernel.sessions.get(chat.id).at(-1))).toContain("Books answered: now.");
    // A chat that is gone takes nothing, quietly.
    kernel.noteIn("nowhere", "lost");
  });

  it("hands a brief to a project's orchestrator as an attributed message, and tells the source chat when it answers", async () => {
    const seen: string[] = [];
    kernel = await boot({
      async generate(_t, req: GenerateRequest): Promise<ModelResponse> {
        const last = req.messages[req.messages.length - 1];
        seen.push(last?.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("") ?? "");
        return { content: [{ type: "text", text: "Got it." }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" };
      },
    });
    const notes: string[] = [];
    kernel.progress.subscribe((e) => {
      if (e.kind === "note") notes.push(`${e.conversationId}: ${e.text}`);
    });
    const books = kernel.standUpProject({ name: "Books", type: "tracker" });
    const source = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Main" });
    const done = await kernel.handoff({ from: source.id, to: "@project:books", brief: "Seventeen books restored.", ask: "check the lending table", by: "owner" });
    expect(done).toMatchObject({ conversationId: books.conversationId, title: "Books" });
    await vi.waitFor(() => expect(notes).toEqual([`${source.id}: Books answered: Got it.`]));
    // The answer is in the source chat's transcript too, not only on screen at the time.
    expect(JSON.stringify(kernel.sessions.get(source.id))).toContain("Books answered: Got it.");
    const delivered = seen.find((t) => t.includes("Handed off from"))!;
    expect(delivered).toContain(`Handed off from "Main" (@chat:[${source.id}]) at the owner's request.`);
    expect(delivered).toContain("Seventeen books restored.");
    expect(delivered).toContain("What is asked of you now: check the lending table");
    // A chat by id works too; a name that is neither does not, nor does handing to itself.
    expect((await kernel.handoff({ to: source.id, brief: "x", by: "agent" })).conversationId).toBe(source.id);
    await expect(kernel.handoff({ from: source.id, to: source.id, brief: "x", by: "agent" })).rejects.toThrow(/this chat/);
    await expect(kernel.handoff({ to: "nowhere", brief: "x", by: "agent" })).rejects.toThrow(/no chat, project or blob/);
    // A standing agent is a target too, by mention or by name: its own thread.
    kernel.roles.write({ name: "research", description: "Looks things up", brief: "You look.", memory: "own" });
    const toAgent = await kernel.handoff({ to: "@agent:research", brief: "The kettle question.", by: "owner" });
    expect(toAgent).toMatchObject({ conversationId: "agent:research", title: "Research" });
    expect((await kernel.handoff({ to: "research", brief: "Again.", by: "owner" })).conversationId).toBe("agent:research");
    await expect(kernel.handoff({ to: "@project:books", brief: "   ", by: "agent" })).rejects.toThrow(/brief is required/);
    // The draft comes from the cheap model over the thread's spoken turns.
    await kernel.handleMessage("remember the lending table", { sessionId: source.id });
    expect(await kernel.draftHandoff(source.id)).toBe("Got it.");
  });

  it("deletes a project with its data, keeping its chats archived at the root and turning its jobs off", async () => {
    kernel = await boot(stubInference([]));
    const books = kernel.standUpProject({ name: "Books", type: "tracker" });
    const chat = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Shelf", projectSlug: books.slug });
    const job = kernel.crons.create({ name: "Nightly shelf", schedule: "0 9 * * *", type: "self_prompt", prompt: "count the books", projectSlug: books.slug });
    const gone = kernel.deleteProject(books.slug);
    expect(gone).toMatchObject({ slug: books.slug, conversationsArchived: 2, jobsDisabled: 1 });
    expect(kernel.manifest.get(books.slug)).toBeUndefined();
    const kept = kernel.conversations.get(chat.id)!;
    expect(kept.archived).toBe(true);
    expect(kept.projectSlug).toBeNull();
    expect(kernel.conversations.get(books.conversationId)?.archived).toBe(true);
    const off = kernel.crons.get(job.id)!;
    expect(off.enabled).toBe(false);
    expect(off.projectSlug).toBeNull();
    expect(off.prompt).toBe("count the books");
  });

  it("names every table of its own in the sql fence, so a new store cannot slip past it", async () => {
    kernel = await boot(stubInference([]));
    const tables = (kernel.workspace.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((r) => r.name);
    expect(tables.length).toBeGreaterThan(10);
    expect(tables.filter((t) => !isKernelTable(t))).toEqual([]);
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

  it("ships a memory job, off, on the cheap route, with a brief the owner can read", async () => {
    kernel = await boot(stubInference([]));
    const job = kernel.crons.list().find((c) => c.name === "kos.memory")!;
    expect(job).toMatchObject({ type: "self_prompt", enabled: false, task: "cheap" });
    expect(job.prompt).toContain("memory.unread");
    expect(job.prompt).toContain("memory.mark_read");
    const dream = kernel.crons.list().find((c) => c.name === "kos.dream")!;
    expect(dream).toMatchObject({ type: "self_prompt", enabled: false, task: "cheap", schedule: "0 4 * * *" });
    expect(dream.prompt).toContain("memory.review");
    const observe = kernel.crons.list().find((c) => c.name === "kos.observe")!;
    expect(observe).toMatchObject({ type: "self_prompt", enabled: false, task: "cheap" });
    expect(observe.prompt).toContain("memory.observe");
  });

  it("runs a scheduled actions job through the guarded path", async () => {
    const sent: string[] = [];
    kernel = await boot(stubInference([]), async (payload) => {
      sent.push(payload.text);
    });
    const job = kernel.crons.create({
      name: "ping",
      schedule: "0 0 1 1 *",
      type: "actions",
      actions: [{ tool: "notify", args: { text: "scheduled hi" } }],
    });
    kernel.startCron();
    // Fired by hand rather than waiting for the tick; the same path either way.
    await kernel.fireCron(job.id);
    await kernel.queue.drain();
    expect(sent).toEqual(["scheduled hi"]);
    expect(kernel.runs.recent().some((r) => r.kind === "cron" && r.status === "ok")).toBe(
      true,
    );
    kernel.stopCron();
  });

  it("keeps what a turn was given from memory, so the chat can show it", async () => {
    kernel = await boot({
      async generate(): Promise<ModelResponse> {
        return {
          content: [{ type: "text", text: "ok" }],
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0 },
          model: "stub",
        };
      },
    });
    const owner = kernel.profile.ownerId;
    kernel.facts.upsert(owner, { key: "name", value: "Sam", kind: "fact", pinned: true }, "test");
    kernel.facts.upsert(owner, { key: "favorite_tea", value: "oolong", kind: "preference" }, "test");
    await kernel.handleMessage("which tea do I like, and is oolong a favorite tea?", { sessionId: "s1" });
    const got = kernel.recalled("s1");
    expect(got?.facts.map((f) => f.key)).toContain("name");
    expect(got?.facts.map((f) => f.key)).toContain("favorite_tea");
    expect(kernel.recalled("nothing")).toBeUndefined();
  });
});
