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
    expect(after.filter((t) => /^Approved #\d+\.$/.test(t))).toEqual([]);
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
