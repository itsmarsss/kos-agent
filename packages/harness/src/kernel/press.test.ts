import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Inference } from "../agent/loop.js";
import type { ModelResponse } from "../models/types.js";
import type { ModalSpec, OutboundMessage } from "../channels/types.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Kernel } from "./kernel.js";
import { createPressHandler, pressMessage } from "./press.js";

function text(body: string): ModelResponse {
  return {
    content: [{ type: "text", text: body }],
    stopReason: "end_turn",
    usage: { inputTokens: 0, outputTokens: 0 },
    model: "stub",
  };
}

function scripted(responses: ModelResponse[]): Inference {
  let i = 0;
  return {
    generate: async () => responses[Math.min(i++, responses.length - 1)]!,
  } as unknown as Inference;
}

/** Records the sequence, which is the part the surface constrains. */
function responderSpy(values?: Record<string, string>) {
  const calls: string[] = [];
  const sent: OutboundMessage[] = [];
  const followedUp: OutboundMessage[] = [];
  return {
    calls,
    sent,
    followedUp,
    responder: {
      openForm: async (modal: ModalSpec) => {
        calls.push(`openForm:${modal.title}`);
        return values;
      },
      working: async (opts?: { ephemeral?: boolean }) => {
        calls.push(`working:${opts?.ephemeral ? "private" : "public"}`);
      },
      followUp: async (msg: OutboundMessage) => {
        calls.push("followUp");
        followedUp.push(msg);
      },
      send: async (msg: OutboundMessage) => {
        calls.push("send");
        sent.push(msg);
      },
    },
  };
}

describe("answering a press", () => {
  let root: string;
  let kernel: Kernel | undefined;

  afterEach(() => {
    kernel?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  async function boot(inference: Inference): Promise<Kernel> {
    root = mkdtempSync(join(tmpdir(), "kos-press-h-"));
    return Kernel.boot({
      rootDir: root,
      secrets: new SecretsRegistry(),
      inference,
      profileOverrides: { name: "Kenny", timezone: "UTC" },
    });
  }

  it("tells the turn which surface its answer is for", async () => {
    /*
     * A press answer is written for the surface the press came from, so the
     * turn has to be told which one. It was not, and the answer came back
     * formatted for nowhere in particular; the same omission had already cost
     * a card, back when a card could ride on a reply.
     */
    // generate takes the task first, and the cheap task is the salience pass
    // rather than the turn: reading its prompt would test the wrong call.
    const seen: string[] = [];
    const model: Inference = {
      generate: async (task: string, req: { system?: string }) => {
        if (task === "cheap") return text('{"facts":[]}');
        seen.push(req.system ?? "");
        return text("Done.");
      },
    } as unknown as Inference;
    kernel = await boot(model);
    const token = kernel.presses.register({
      conversationId: "primary:owner",
      buttonId: "show",
      label: "Show the budget",
    });

    const spy = responderSpy();
    const handle = createPressHandler({ kernel, channel: "discord" });
    await handle(
      { buttonId: "", label: "Show the budget", token, pressedBy: "u1" },
      spy.responder,
    );

    expect(seen[0]).toContain("Replying on Discord");
    expect(spy.sent[0]?.text).toContain("Done.");
  });

  it("sends a card during the turn back into the press, not to the inbox", async () => {
    /*
     * A surface can make an interaction response private and cannot make an
     * ordinary message private at all, so a card sent any other way during a
     * press is a public answer to a private button.
     */
    const model: Inference = {
      generate: async (task: string) => {
        if (task === "cheap") return text('{"facts":[]}');
        if (seenCall++ === 0) {
          return {
            content: [
              {
                type: "tool_use",
                id: "n1",
                name: "notify",
                input: { text: "here it is", card: { title: "Budget" } },
              },
            ],
            stopReason: "tool_use",
            usage: { inputTokens: 0, outputTokens: 0 },
            model: "stub",
          } as ModelResponse;
        }
        return text("Done.");
      },
    } as unknown as Inference;
    let seenCall = 0;
    kernel = await boot(model);
    const token = kernel.presses.register({
      conversationId: "primary:owner",
      buttonId: "show",
      label: "Show the budget",
      ephemeral: true,
    });

    const spy = responderSpy();
    const handle = createPressHandler({ kernel, channel: "discord" });
    await handle(
      { buttonId: "", label: "Show the budget", token, pressedBy: "u1" },
      spy.responder,
    );

    // Into the interaction, carrying the card, before the answer.
    expect(spy.calls).toEqual(["working:private", "followUp", "send"]);
    expect(spy.followedUp[0]?.card?.title).toBe("Budget");
  });

  it("puts the surface away when the turn ends", async () => {
    kernel = await boot(scripted([text("done")]));
    const token = kernel.presses.register({
      conversationId: "primary:owner",
      buttonId: "x",
      label: "X",
    });
    const spy = responderSpy();
    const handle = createPressHandler({ kernel, channel: "discord" });
    await handle({ buttonId: "", label: "X", token, pressedBy: "u1" }, spy.responder);

    // An interaction is good for minutes. A later turn sending into a stale
    // one is a message nobody sees.
    expect(kernel.replySurfaceFor("primary:owner")).toBeUndefined();
  });

  it("shows the form, then works, then answers", async () => {
    const model = scripted([text("Logged it.")]);
    kernel = await boot(model);
    const token = kernel.presses.register({
      conversationId: "primary:owner",
      buttonId: "log",
      label: "Log an expense",
      modal: { title: "Log an expense", fields: [{ id: "amount", label: "Amount" }] },
      ephemeral: true,
    });

    const spy = responderSpy({ amount: "40" });
    const handle = createPressHandler({ kernel, channel: "discord" });
    await handle(
      { buttonId: "", label: "Log an expense", token, pressedBy: "u1" },
      spy.responder,
    );

    // The order is the surface's rule, not a preference: a form cannot be
    // shown after the interaction has been acknowledged any other way.
    expect(spy.calls).toEqual([
      "openForm:Log an expense",
      "working:private",
      "send",
    ]);
    expect(spy.sent[0]?.text).toContain("Logged it.");
  });

  it("runs nothing when the form is closed", async () => {
    const model = scripted([text("should not run")]);
    kernel = await boot(model);
    const token = kernel.presses.register({
      conversationId: "primary:owner",
      buttonId: "log",
      label: "Log",
      modal: { title: "Log", fields: [{ id: "a", label: "A" }] },
    });

    const spy = responderSpy(undefined);
    const handle = createPressHandler({ kernel, channel: "discord" });
    await handle({ buttonId: "", label: "Log", token, pressedBy: "u1" }, spy.responder);

    // Deciding not to answer is not a turn to run on nothing.
    expect(spy.calls).toEqual(["openForm:Log"]);
  });

  it("says so rather than going quiet on a button it no longer knows", async () => {
    kernel = await boot(scripted([text("hi")]));
    const spy = responderSpy();
    const handle = createPressHandler({ kernel, channel: "discord" });
    await handle(
      { buttonId: "", label: "Gone", token: "made-up", pressedBy: "u1" },
      spy.responder,
    );
    expect(spy.sent[0]?.text).toContain("too old");
  });

  it("tells the agent who pressed and what they typed", () => {
    const route = { label: "Log an expense", buttonId: "log" };
    const mine = pressMessage(
      { buttonId: "", label: "x", token: "t", pressedBy: "owner-id" },
      route,
      { amount: "40", note: "coffee" },
      "owner-id",
    );
    expect(mine).toContain('[you pressed "Log an expense" (log)]');
    expect(mine).toContain("amount: 40");
    expect(mine).toContain("note: coffee");

    // Someone else is named rather than read as the owner.
    const theirs = pressMessage(
      { buttonId: "", label: "x", token: "t", pressedBy: "stranger" },
      route,
      undefined,
      "owner-id",
    );
    expect(theirs).toContain("stranger pressed");
    expect(theirs).not.toContain(":");
  });
});
