// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Inference } from "../agent/loop.js";
import type { ModelResponse } from "../models/types.js";
import { DiscordAdapter } from "../channels/discord.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Kernel } from "./kernel.js";
import { createPressHandler } from "./press.js";

/**
 * What actually reaches Discord after a press.
 *
 * The real adapter, driven through its real interaction handler, with only
 * the surface's own objects faked. Everything else on this path is the
 * shipping code, because the question this answers -- does the turn's reply
 * text get sent as well as the message the agent composed -- cannot be
 * answered by a test that stops short of the wire.
 */

/** Everything Discord is asked to do, in order, with the literal payloads. */
const wire: { call: string; payload?: unknown }[] = [];

function fakeInteraction(customId: string): Record<string, unknown> {
  return {
    isButton: () => true,
    customId,
    user: { id: "owner-id" },
    component: { label: "Show the budget" },
    deferUpdate: async () => wire.push({ call: "deferUpdate" }),
    deferReply: async (o?: unknown) => wire.push({ call: "deferReply", payload: o }),
    editReply: async (p: unknown) => wire.push({ call: "editReply", payload: p }),
    reply: async (p: unknown) => wire.push({ call: "reply", payload: p }),
    followUp: async (p: unknown) => wire.push({ call: "followUp", payload: p }),
  };
}

describe("what reaches Discord after a notify", () => {
  it("hands over the sent message and nothing the turn wrote after it", async () => {
    const root = mkdtempSync(join(tmpdir(), "kos-proof-"));
    let turn = 0;
    const model: Inference = {
      generate: async (task: string) => {
        if (task === "cheap") {
          return { content: [{ type: "text", text: '{"facts":[]}' }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "s" } as ModelResponse;
        }
        if (turn++ === 0) {
          return {
            content: [{
              type: "tool_use", id: "n1", name: "notify",
              input: { text: "Here is the budget.", card: { title: "Budget", fields: [{ name: "Spent", value: "40" }] } },
            }],
            stopReason: "tool_use", usage: { inputTokens: 0, outputTokens: 0 }, model: "s",
          } as ModelResponse;
        }
        return {
          content: [{ type: "text", text: "SENTINEL_PROSE: I have sent you a card with the budget in it." }],
          stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "s",
        } as ModelResponse;
      },
    } as unknown as Inference;

    const kernel = await Kernel.boot({
      rootDir: root,
      secrets: new SecretsRegistry(),
      inference: model,
      profileOverrides: { name: "Kenny", timezone: "UTC" },
    });
    const token = kernel.presses.register({
      conversationId: "primary:owner",
      buttonId: "show",
      label: "Show the budget",
      ephemeral: true,
    });

    // The real adapter, driven through its real interaction handler.
    const adapter = new DiscordAdapter({ token: "t" });
    adapter.setAuthorizer(() => true);
    adapter.onButton(createPressHandler({ kernel, channel: "discord" }));
    await adapter.receiveInteraction(
      fakeInteraction(`kos:press:${token}`) as never,
    );

    /*
     * Two calls, and only two: acknowledge privately, then say the thing.
     * The turn did write a sentence after sending its message, and the point
     * of this test is that no such sentence can reach the surface, whatever
     * the agent decides to say.
     */
    expect(wire.map((w) => w.call)).toEqual(["deferReply", "editReply"]);
    expect(wire[0]?.payload).toEqual({ flags: 64 });
    const everything = JSON.stringify(wire);
    expect(everything).not.toContain("SENTINEL_PROSE");
    expect(everything).toContain("Here is the budget.");
    expect(everything).toContain("Budget");

    kernel.close();
    rmSync(root, { recursive: true, force: true });
  });
});
