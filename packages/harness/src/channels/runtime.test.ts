import { describe, expect, it } from "vitest";

import type { ModelResponse } from "../models/types.js";
import { ToolRegistry } from "../agent/registry.js";
import { SingleOwnerMapping, type UserMapping } from "./identity.js";
import { InMemoryAdapter } from "./memory.js";
import { ChannelRuntime, createAgentTurnHandler } from "./runtime.js";

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
