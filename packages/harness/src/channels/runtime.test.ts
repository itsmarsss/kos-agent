import { describe, expect, it } from "vitest";

import type { ModelResponse } from "../models/types.js";
import type { ProgressEvent } from "../kernel/progress.js";
import { ToolRegistry } from "../agent/registry.js";
import {
  AllowlistMapping,
  SingleOwnerMapping,
  type UserMapping,
} from "./identity.js";
import { InMemoryAdapter } from "./memory.js";
import {
  ChannelRuntime,
  createAgentTurnHandler,
  type RejectedInbound,
} from "./runtime.js";

describe("ChannelRuntime", () => {
  it("resolves the user, runs the turn, and sends the reply", async () => {
    const adapter = new InMemoryAdapter();
    const seen: string[] = [];
    const runtime = new ChannelRuntime({
      adapter,
      handleTurn: async (ctx) => {
        seen.push(ctx.userId);
        return `echo: ${ctx.text}`;
      },
    });
    await runtime.start();

    await adapter.receive({ channel: "memory", senderId: "u1", text: "hi" });

    expect(seen).toEqual(["owner"]); // SingleOwnerMapping default
    expect(adapter.sent).toEqual([
      { recipientId: "u1", msg: { text: "echo: hi" } },
    ]);
  });

  it("sends a shaped answer as one message, not an answer and then a card", async () => {
    const adapter = new InMemoryAdapter();
    const runtime = new ChannelRuntime({
      adapter,
      handleTurn: async () => ({
        text: "you are 40 in",
        card: { title: "Budget" },
        buttons: [{ label: "Rows", token: "t1" }],
      }),
    });
    await runtime.start();

    await adapter.receive({ channel: "memory", senderId: "u1", text: "hi" });

    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]?.msg).toEqual({
      text: "you are 40 in",
      card: { title: "Budget" },
      buttons: [{ label: "Rows", token: "t1" }],
    });
  });

  it("stands in for an empty answer, but not for one that is only a card", async () => {
    const adapter = new InMemoryAdapter();
    const runtime = new ChannelRuntime({
      adapter,
      handleTurn: async () => ({ text: "", card: { title: "Done" } }),
    });
    await runtime.start();

    await adapter.receive({ channel: "memory", senderId: "u1", text: "hi" });

    // A turn that answered with a card said something; only a turn that said
    // nothing at all needs standing in for.
    expect(adapter.sent[0]?.msg.text).toBe("");
    expect(adapter.sent[0]?.msg.card).toEqual({ title: "Done" });
  });

  it("sends an error reply instead of leaking a thrown error", async () => {
    const adapter = new InMemoryAdapter();
    const runtime = new ChannelRuntime({
      adapter,
      errorReply: "oops",
      handleTurn: async () => {
        throw new Error("kaboom");
      },
    });
    await runtime.start();

    await adapter.receive({ channel: "memory", senderId: "u1", text: "x" });
    expect(adapter.sent[0]?.msg.text).toBe("oops");
  });

  it("uses a custom identity mapping", async () => {
    const adapter = new InMemoryAdapter();
    const mapping: UserMapping = { resolve: (_c, s) => `user:${s}` };
    let resolved = "";
    const runtime = new ChannelRuntime({
      adapter,
      identity: mapping,
      handleTurn: async (ctx) => {
        resolved = ctx.userId;
        return "ok";
      },
    });
    await runtime.start();
    await adapter.receive({ channel: "memory", senderId: "abc", text: "y" });
    expect(resolved).toBe("user:abc");
  });

  it("runs the turn for a mapped sender", async () => {
    const adapter = new InMemoryAdapter();
    const seen: string[] = [];
    const runtime = new ChannelRuntime({
      adapter,
      identity: new AllowlistMapping([
        { channel: "memory", senderId: "owner-id" },
      ]),
      handleTurn: async (ctx) => {
        seen.push(ctx.userId);
        return "ok";
      },
    });
    await runtime.start();

    await adapter.receive({
      channel: "memory",
      senderId: "owner-id",
      text: "hi",
    });
    expect(seen).toEqual(["owner"]);
    expect(adapter.sent).toEqual([
      { recipientId: "owner-id", msg: { text: "ok" } },
    ]);
  });

  it("runs a guest's words in the owner's chat, marked as a guest's, and still drops a stranger", async () => {
    const adapter = new InMemoryAdapter();
    const seen: Array<{ userId: string; guest?: { id: string; name: string } }> = [];
    const runtime = new ChannelRuntime({
      adapter,
      ownerRecipientId: "owner-id",
      identity: new AllowlistMapping([{ channel: "memory", senderId: "owner-id" }]),
      handleTurn: async (ctx) => {
        seen.push({ userId: ctx.userId, ...(ctx.guest ? { guest: ctx.guest } : {}) });
        return "ok";
      },
    });
    await runtime.start();
    await adapter.receive({ channel: "memory", senderId: "u9", text: "hi", guest: { id: "u9", name: "Ana" } });
    await adapter.receive({ channel: "memory", senderId: "u9", text: "hi again" });
    expect(seen).toEqual([{ userId: "owner", guest: { id: "u9", name: "Ana" } }]);
  });

  it("drops a message from an unmapped sender without running the turn", async () => {
    const adapter = new InMemoryAdapter();
    const rejected: RejectedInbound[] = [];
    let ran = false;
    const runtime = new ChannelRuntime({
      adapter,
      identity: new AllowlistMapping([
        { channel: "memory", senderId: "owner-id" },
      ]),
      onRejected: (event) => rejected.push(event),
      handleTurn: async () => {
        ran = true;
        return "secret";
      },
    });
    await runtime.start();

    await adapter.receive({
      channel: "memory",
      senderId: "stranger",
      text: "whoami",
    });

    expect(ran).toBe(false);
    expect(adapter.sent).toEqual([]);
    expect(rejected).toEqual([
      { channel: "memory", senderId: "stranger", kind: "message" },
    ]);
  });

  it("drops an approval decision from an unmapped decider", async () => {
    const adapter = new InMemoryAdapter();
    const rejected: RejectedInbound[] = [];
    let decided = false;
    const runtime = new ChannelRuntime({
      adapter,
      identity: new AllowlistMapping([
        { channel: "memory", senderId: "owner-id" },
      ]),
      onRejected: (event) => rejected.push(event),
      handleTurn: async () => "ok",
      handleDecision: () => {
        decided = true;
      },
    });
    await runtime.start();

    await adapter.decide({ id: "7", approved: true, deciderId: "stranger" });
    expect(decided).toBe(false);
    expect(rejected).toEqual([
      {
        channel: "memory",
        senderId: "stranger",
        kind: "approval",
        pendingId: "7",
      },
    ]);

    await adapter.decide({ id: "7", approved: true, deciderId: "owner-id" });
    expect(decided).toBe(true);
  });

  it("installs an authorizer on adapters that accept one", async () => {
    const adapter = new InMemoryAdapter() as InMemoryAdapter & {
      setAuthorizer(fn: (senderId: string) => boolean): void;
    };
    let authorize: ((senderId: string) => boolean) | undefined;
    adapter.setAuthorizer = (fn) => {
      authorize = fn;
    };
    const runtime = new ChannelRuntime({
      adapter,
      identity: new AllowlistMapping([
        { channel: "memory", senderId: "owner-id" },
      ]),
      handleTurn: async () => "ok",
    });
    await runtime.start();

    expect(authorize?.("owner-id")).toBe(true);
    expect(authorize?.("stranger")).toBe(false);
  });
});

describe("telling the turn's story on a surface with a presence", () => {
  it("shows a step at once, text in between on a timer, and the steps alone when the answer lands", async () => {
    const adapter = new InMemoryAdapter();
    adapter.withPresence = true;
    let tell: ((event: ProgressEvent) => void) | undefined;
    const watched: string[] = [];
    const runtime = new ChannelRuntime({
      adapter,
      narrateEveryMs: 40,
      watchTurn: (ctx, listener) => {
        watched.push(`${ctx.channel}:${ctx.userId}`);
        tell = listener;
        return () => {
          tell = undefined;
        };
      },
      handleTurn: async () => {
        // The turn, as the kernel would report it: words, a step, more words, the answer.
        tell!({ kind: "delta", conversationId: "c", of: "text", text: "Let me look." });
        tell!({ kind: "tool-start", conversationId: "c", tool: "files.ls", summary: "List x" });
        tell!({ kind: "tool-end", conversationId: "c", tool: "files.ls", isError: false });
        tell!({ kind: "delta", conversationId: "c", of: "text", text: "Three files, " });
        tell!({ kind: "delta", conversationId: "c", of: "text", text: "all fine." });
        await new Promise((r) => setTimeout(r, 70));
        // The kernel says the turn is over before the handler returns; the
        // story must still settle to its steps, not keep the answer.
        tell!({ kind: "turn-end", conversationId: "c" });
        return "Three files, all fine.";
      },
    });
    await runtime.start();
    await adapter.receive({ channel: "memory", senderId: "u1", text: "look" });
    expect(watched).toEqual(["memory:owner"]);
    // A step is shown the moment it starts; the text after it waits for the timer; the end keeps the steps.
    expect(adapter.shown).toEqual(["Let me look.\n› List x", "Let me look.\n› List x\nThree files, all fine.", "Let me look.\n› List x"]);
    expect(adapter.completed).toEqual([{ text: "Three files, all fine." }]);
    expect(tell).toBeUndefined();
  });

  it("says a message is queued when a turn is already running where it goes, and tells only its own turn's story", async () => {
    const adapter = new InMemoryAdapter();
    adapter.withPresence = true;
    let tell: ((event: ProgressEvent) => void) | undefined;
    const runtime = new ChannelRuntime({
      adapter,
      narrateEveryMs: 10,
      isBusy: () => true,
      watchTurn: (_ctx, listener) => {
        tell = listener;
        return () => {
          tell = undefined;
        };
      },
      handleTurn: async () => {
        // The turn already running there: its steps and its end are not this message's.
        tell!({ kind: "tool-start", conversationId: "c", tool: "blobs.list", summary: "List the blobs" });
        tell!({ kind: "tool-end", conversationId: "c", tool: "blobs.list", isError: false });
        tell!({ kind: "turn-end", conversationId: "c" });
        // Then its own.
        tell!({ kind: "turn-start", conversationId: "c", said: "and this" });
        tell!({ kind: "tool-start", conversationId: "c", tool: "files.ls", summary: "List x" });
        tell!({ kind: "tool-end", conversationId: "c", tool: "files.ls", isError: false });
        await new Promise((r) => setTimeout(r, 30));
        tell!({ kind: "turn-end", conversationId: "c" });
        return "Done.";
      },
    });
    await runtime.start();
    await adapter.receive({ channel: "memory", senderId: "u1", text: "and this" });
    expect(adapter.shown[0]).toBe("-# queued: a turn is running here, this one is next");
    expect(adapter.shown.some((s) => s.includes("List the blobs"))).toBe(false);
    expect(adapter.shown.some((s) => s.includes("List x"))).toBe(true);
    expect(adapter.completed).toEqual([{ text: "Done." }]);
  });

  it("shows nothing for a turn that takes no step", async () => {
    const adapter = new InMemoryAdapter();
    adapter.withPresence = true;
    const runtime = new ChannelRuntime({
      adapter,
      watchTurn: (_ctx, listener) => {
        listener({ kind: "delta", conversationId: "c", of: "text", text: "Hello there." });
        return () => undefined;
      },
      handleTurn: async () => "Hello there.",
    });
    await runtime.start();
    await adapter.receive({ channel: "memory", senderId: "u1", text: "hi" });
    expect(adapter.shown).toEqual([]);
    expect(adapter.completed).toEqual([{ text: "Hello there." }]);
  });
});

describe("createAgentTurnHandler", () => {
  it("runs the agent and returns its final text", async () => {
    const inference = {
      async generate(): Promise<ModelResponse> {
        return {
          content: [{ type: "text", text: "answer" }],
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0 },
          model: "mock",
        };
      },
    };
    const handler = createAgentTurnHandler(inference, new ToolRegistry());
    const reply = await handler({
      userId: "owner",
      channel: "memory",
      senderId: "u1",
      text: "hello",
    });
    expect(reply).toBe("answer");
  });
});

describe("SingleOwnerMapping", () => {
  it("maps any sender to the owner", () => {
    const m = new SingleOwnerMapping();
    expect(m.resolve("discord", "anyone")).toBe("owner");
  });
});

describe("AllowlistMapping", () => {
  it("resolves a listed sender to the default owner", () => {
    const m = new AllowlistMapping([{ channel: "discord", senderId: "123" }]);
    expect(m.resolve("discord", "123")).toBe("owner");
  });

  it("resolves a listed sender to its own user id", () => {
    const m = new AllowlistMapping([
      { channel: "discord", senderId: "123", userId: "u-a" },
      { channel: "discord", senderId: "456", userId: "u-b" },
    ]);
    expect(m.resolve("discord", "456")).toBe("u-b");
  });

  it("returns null for an unlisted sender", () => {
    const m = new AllowlistMapping([{ channel: "discord", senderId: "123" }]);
    expect(m.resolve("discord", "999")).toBeNull();
  });

  it("scopes entries per channel", () => {
    const m = new AllowlistMapping([{ channel: "discord", senderId: "123" }]);
    expect(m.resolve("sms", "123")).toBeNull();
  });
});

describe("a surface that cannot deliver", () => {
  it("does not take the host down with it", async () => {
    /*
     * The reply failed, so the runtime tried to say so, and that failed too.
     * The second await was unguarded, so the rejection escaped dispatch, then
     * the onMessage callback, and killed the process -- which is how a
     * missing Automation permission on one message stopped all of KOS.
     */
    const adapter = new InMemoryAdapter();
    const runtime = new ChannelRuntime({
      adapter,
      handleTurn: async () => {
        throw new Error("the turn failed");
      },
    });
    adapter.send = async () => {
      throw new Error("Messages refused the send");
    };
    await runtime.start();

    await expect(
      adapter.receive({ channel: "memory", senderId: "owner", text: "hi" }),
    ).resolves.toBeUndefined();

    await runtime.stop();
  });

  it("still reports a failed turn when the surface is working", async () => {
    const adapter = new InMemoryAdapter();
    const runtime = new ChannelRuntime({
      adapter,
      handleTurn: async () => {
        throw new Error("the turn failed");
      },
      errorReply: "that did not work",
    });
    await runtime.start();
    await adapter.receive({ channel: "memory", senderId: "owner", text: "hi" });
    await runtime.stop();

    expect(adapter.sent.map((m) => m.msg.text)).toEqual(["that did not work"]);
  });
});
