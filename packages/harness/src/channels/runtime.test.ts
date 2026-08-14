import { describe, expect, it } from "vitest";

import type { ModelResponse } from "../models/types.js";
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
