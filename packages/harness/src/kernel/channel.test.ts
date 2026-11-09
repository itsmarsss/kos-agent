import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Inference } from "../agent/loop.js";
import { AllowlistMapping } from "../channels/identity.js";
import { InMemoryAdapter } from "../channels/memory.js";
import type { ModelResponse } from "../models/types.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import type { ChannelRuntime } from "../channels/runtime.js";
import { connectChannel } from "./channel.js";
import { Kernel } from "./kernel.js";
import { primarySessionId } from "./session.js";

function stub(script: ModelResponse[]): Inference {
  const q = [...script];
  return {
    async generate() {
      return (
        q.shift() ?? {
          content: [{ type: "text", text: "done" }],
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0 },
          model: "stub",
        }
      );
    },
  };
}

describe("connectChannel", () => {
  let root: string;
  let kernel: Kernel;
  let adapter: InMemoryAdapter;
  let runtime: ChannelRuntime;

  afterEach(() => {
    kernel?.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function boot(
    inference: Inference,
    identity?: AllowlistMapping,
  ): Promise<void> {
    root = mkdtempSync(join(tmpdir(), "kos-chan-"));
    adapter = new InMemoryAdapter();
    kernel = await Kernel.boot({
      rootDir: root,
      secrets: new SecretsRegistry(),
      inference,
      onApprovalRequested: (action) => {
        void adapter.requestApproval("owner", {
          id: String(action.id),
          text: `Approve ${action.tool}?`,
        });
      },
    });
    runtime = connectChannel(adapter, kernel, {
      ownerRecipientId: "owner",
      ...(identity ? { identity } : {}),
    });
    await runtime.start();
  }

  function riskyScript(): ModelResponse[] {
    return [
      {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "files.rm",
            input: { path: "projects/important.txt" },
          },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 0, outputTokens: 0 },
        model: "stub",
      },
      {
        content: [{ type: "text", text: "queued" }],
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
        model: "stub",
      },
    ];
  }

  it("turns an inbound message into a reply", async () => {
    await boot(
      stub([
        {
          content: [{ type: "text", text: "hi back" }],
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0 },
          model: "stub",
        },
      ]),
    );
    await adapter.receive({ channel: "memory", senderId: "u1", text: "hi" });
    expect(adapter.sent[0]?.msg.text).toBe("hi back");
  });

  it("decides what the chat is waiting on with /approve and /deny", async () => {
    await boot(stub(riskyScript()));
    await adapter.receive({ channel: "memory", senderId: "u1", text: "delete it" });
    expect(kernel.approvals.pending()).toHaveLength(1);

    await adapter.receive({ channel: "memory", senderId: "u1", text: "/status" });
    expect(adapter.sent.at(-1)?.msg.text).toMatch(/Waiting on you: 1 action \(1 in this chat/);

    await adapter.receive({ channel: "memory", senderId: "u1", text: "/approve" });
    expect(adapter.sent.at(-1)?.msg.text).toMatch(/^Approved @approval:\d+ /);
    expect(kernel.approvals.pending()).toHaveLength(0);

    await adapter.receive({ channel: "memory", senderId: "u1", text: "/deny" });
    expect(adapter.sent.at(-1)?.msg.text).toMatch(/Nothing is waiting on you in this chat/);
  });

  it("forks a chat with its history, its brief and its project, and moves to the copy", async () => {
    await boot(
      stub([
        {
          content: [{ type: "text", text: "hi back" }],
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0 },
          model: "stub",
        },
      ]),
    );
    await adapter.receive({ channel: "memory", senderId: "u1", text: "hi" });
    // The sender is the owner; the surface's stream is the owner's.
    const before = kernel.conversationFor("memory", "owner").id;
    kernel.conversations.configure(before, { brief: "Be brief." });

    await adapter.receive({ channel: "memory", senderId: "u1", text: "/fork Second take" });
    expect(adapter.sent.at(-1)?.msg.text).toMatch(/Forked into “Second take”/);
    const after = kernel.conversations.activeFor("memory", "owner");
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
    const fork = kernel.conversations.get(after!);
    expect(fork).toMatchObject({ title: "Second take", brief: "Be brief." });
    expect(kernel.sessions.get(after!)).toEqual(kernel.sessions.get(before));
  });

  it("surfaces a risky tool call as an approval prompt, then executes on approve", async () => {
    await boot(stub(riskyScript()));
    await adapter.receive({ channel: "memory", senderId: "u1", text: "delete it" });

    // a prompt was sent to the owner with the pending id
    expect(adapter.approvalsRequested).toHaveLength(1);
    const pendingId = adapter.approvalsRequested[0]!.req.id;
    expect(kernel.approvals.pending()).toHaveLength(1);

    // owner approves -> action resolves
    await adapter.decide({ id: pendingId, approved: true, deciderId: "owner" });
    expect(kernel.approvals.pending()).toHaveLength(0);
  });

  it("does not restate a decision the surface already showed", async () => {
    /*
     * A surface settles its own prompt in place: the card becomes "Approved,
     * running #96" and the buttons go. Sending "Approved #96." on top of that
     * made one decision read as two messages, the second saying nothing the
     * first had not.
     */
    await boot(stub(riskyScript()));
    await adapter.receive({ channel: "memory", senderId: "u1", text: "delete it" });
    const pendingId = adapter.approvalsRequested[0]!.req.id;
    const before = adapter.sent.length;

    await adapter.decide({ id: pendingId, approved: true, deciderId: "owner" });

    expect(kernel.approvals.pending()).toHaveLength(0);
    const after = adapter.sent.slice(before).map((m) => m.msg.text ?? "");
    expect(after.filter((t) => /^Approved @approval:\d+\.$/.test(t))).toEqual([]);
  });

  it("after a restart, sends a decision's answer here only when the chat has no channel or thread of its own", async () => {
    for (const mirrored of [false, true]) {
      await boot(stub(riskyScript()));
      await adapter.receive({ channel: "memory", senderId: "u1", text: "delete it" });
      const pendingId = adapter.approvalsRequested[0]!.req.id;
      const chat = kernel.approvals.get(Number(pendingId))!.conversationId!;
      // A new process: nothing is waiting on the ask, so the decision resumes the chat itself.
      await runtime.stop();
      kernel.close();
      adapter = new InMemoryAdapter();
      kernel = await Kernel.boot({ rootDir: root, secrets: new SecretsRegistry(), inference: stub([{ content: [{ type: "text", text: "Deleted it." }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" }]) });
      const asked: string[] = [];
      runtime = connectChannel(adapter, kernel, { ownerRecipientId: "owner", answeredElsewhere: (id) => (asked.push(id), mirrored) });
      await runtime.start();
      await adapter.decide({ id: pendingId, approved: true, deciderId: "owner" });
      expect(asked).toEqual([chat]);
      expect(adapter.sent.map((m) => m.msg.text)).toEqual(mirrored ? [] : ["Deleted it."]);
      kernel.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("says how an ask already went when it is pressed after being decided elsewhere, and decides nothing", async () => {
    await boot(stub(riskyScript()));
    await adapter.receive({ channel: "memory", senderId: "u1", text: "delete it" });
    const pendingId = adapter.approvalsRequested[0]!.req.id;
    await kernel.deny(Number(pendingId));
    const before = adapter.sent.length;
    const settled: unknown[] = [];
    // Straight to the runtime's sink, as the adapter's press does.
    const decide = (runtime as unknown as { decide: (d: unknown) => Promise<unknown> }).decide.bind(runtime);
    settled.push(await decide({ id: pendingId, approved: true, deciderId: "owner" }));
    expect(settled).toEqual([{ outcome: "denied", already: true }]);
    expect(kernel.approvals.get(Number(pendingId))?.status).toBe("denied");
    expect(adapter.sent.length).toBe(before);
  });

  it("reports the recorded decision before the action and the resumed turn have run, and a second press as decided here", async () => {
    await boot(stub(riskyScript()));
    await adapter.receive({ channel: "memory", senderId: "u1", text: "delete it" });
    const pendingId = adapter.approvalsRequested[0]!.req.id;
    // A new process: nothing waits on the ask, so the decision runs the action and resumes the chat itself.
    await runtime.stop();
    kernel.close();
    adapter = new InMemoryAdapter();
    let reply!: () => void;
    const slow: Inference = {
      generate: () =>
        new Promise((r) => {
          reply = () => r({ content: [{ type: "text", text: "Deleted it." }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" });
        }),
    };
    kernel = await Kernel.boot({ rootDir: root, secrets: new SecretsRegistry(), inference: slow });
    runtime = connectChannel(adapter, kernel, { ownerRecipientId: "owner" });
    await runtime.start();
    const decide = (runtime as unknown as { decide: (d: unknown) => Promise<{ outcome: string; already?: boolean; here?: boolean; done?: Promise<void> } | undefined> }).decide.bind(runtime);
    const first = await decide({ id: pendingId, approved: true, deciderId: "owner" });
    expect(first).toMatchObject({ outcome: "approved" });
    expect(first?.done).toBeInstanceOf(Promise);
    expect(adapter.sent).toEqual([]);
    expect(await decide({ id: pendingId, approved: false, deciderId: "owner" })).toEqual({ outcome: "approved", already: true, here: true });
    await new Promise((r) => setTimeout(r, 20));
    reply();
    await first?.done;
    expect(adapter.sent.map((m) => m.msg.text)).toEqual(["Deleted it."]);
  });

  it("reports nothing decided, never approved, when the ask is not there", async () => {
    await boot(stub(riskyScript()));
    const decide = (runtime as unknown as { decide: (d: unknown) => Promise<unknown> }).decide.bind(runtime);
    expect(await decide({ id: "999", approved: true, deciderId: "owner" })).toBeUndefined();
    expect(adapter.sent.map((m) => m.msg.text)).toEqual(["no pending action #999"]);
  });

  it("still speaks up when the decision could not be applied", async () => {
    // Nothing was settled in place for a row that is not there, so silence
    // would be a press that did nothing and said nothing.
    await boot(stub(riskyScript()));
    await adapter.receive({ channel: "memory", senderId: "u1", text: "delete it" });
    const pendingId = adapter.approvalsRequested[0]!.req.id;
    const before = adapter.sent.length;

    // Nothing is waiting on a row this far out of band, so approve() reports
    // rather than resuming a turn.
    await adapter.decide({ id: pendingId + 999, approved: true, deciderId: "owner" });

    const after = adapter.sent.slice(before).map((m) => m.msg.text ?? "");
    expect(after.some((t) => t.includes("no pending action"))).toBe(true);
  });

  it("settles its prompt when the decision is taken in the dashboard", async () => {
    /*
     * A prompt kept its buttons until this surface was the one that answered
     * it. Decided from the dashboard, it sat there still offering a choice
     * that had already been made, and pressing it reported that the action
     * did not exist.
     */
    await boot(stub(riskyScript()));
    await adapter.receive({ channel: "memory", senderId: "u1", text: "delete it" });
    const pendingId = Number(adapter.approvalsRequested[0]!.req.id);

    // The owner answers somewhere else entirely, not through this surface.
    await kernel.approve(pendingId);

    expect(adapter.settled).toEqual([
      { id: String(pendingId), outcome: "approved" },
    ]);
  });

  it("settles a denial the same way", async () => {
    await boot(stub(riskyScript()));
    await adapter.receive({ channel: "memory", senderId: "u1", text: "delete it" });
    const pendingId = Number(adapter.approvalsRequested[0]!.req.id);

    await kernel.deny(pendingId);

    expect(adapter.settled).toEqual([
      { id: String(pendingId), outcome: "denied" },
    ]);
  });

  it("stops listening once the channel stops", async () => {
    // The subscription outliving the runtime would settle prompts on an
    // adapter that is no longer connected to anything.
    await boot(stub(riskyScript()));
    await adapter.receive({ channel: "memory", senderId: "u1", text: "delete it" });
    const pendingId = Number(adapter.approvalsRequested[0]!.req.id);

    await runtime.stop();
    await kernel.approve(pendingId);

    expect(adapter.settled).toEqual([]);
  });

  it("passes a surface's remember through to the kernel", async () => {
    await boot(stub(riskyScript()));
    await adapter.receive({ channel: "memory", senderId: "u1", text: "delete it" });
    const pendingId = adapter.approvalsRequested[0]!.req.id;
    await adapter.decide({ id: pendingId, approved: true, deciderId: "owner", remember: true });
    expect(kernel.permissions.list()).toHaveLength(1);
  });

  it("never runs the kernel for an unmapped sender", async () => {
    await boot(
      stub([]),
      new AllowlistMapping([{ channel: "memory", senderId: "owner-dm" }]),
    );
    await adapter.receive({
      channel: "memory",
      senderId: "stranger",
      text: "read my notes",
    });

    expect(adapter.sent).toEqual([]);
    // nothing reached the kernel: no reply, no session history
    expect(
      kernel.sessions.get(primarySessionId(kernel.profile.ownerId)),
    ).toEqual([]);
  });

  it("leaves a pending action queued when an unmapped sender approves", async () => {
    await boot(
      stub(riskyScript()),
      new AllowlistMapping([{ channel: "memory", senderId: "owner-dm" }]),
    );
    await adapter.receive({
      channel: "memory",
      senderId: "owner-dm",
      text: "delete it",
    });
    const pendingId = adapter.approvalsRequested[0]!.req.id;
    expect(kernel.approvals.pending()).toHaveLength(1);

    await adapter.decide({
      id: pendingId,
      approved: true,
      deciderId: "stranger",
    });
    expect(kernel.approvals.pending()).toHaveLength(1);

    await adapter.decide({
      id: pendingId,
      approved: true,
      deciderId: "owner-dm",
    });
    expect(kernel.approvals.pending()).toHaveLength(0);
  });
});
