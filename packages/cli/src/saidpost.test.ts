import { describe, expect, it } from "vitest";

import type { OutboundMessage } from "@kos/harness";
import { postSaid, type Said, type SaidDeps } from "./saidpost.js";

function deps(targets: Record<string, string> = {}): SaidDeps & { posts: { target: string; text: string }[]; dms: string[] } {
  const posts: { target: string; text: string }[] = [];
  const dms: string[] = [];
  return {
    posts,
    dms,
    targetFor: (conv) => targets[conv],
    jobOf: () => undefined,
    ensureThread: async () => undefined,
    bindThread: () => undefined,
    senderFor: () => undefined,
    speakerFor: (from) => ({ name: from.name }),
    ownerSender: async () => ({ name: "Owner" }),
    filesFor: () => [],
    postIn: async (target, msg: OutboundMessage) => void posts.push({ target, text: msg.text }),
    sendOwner: async (msg) => void dms.push(msg.text),
  };
}

const said = (over: Partial<Said>): Said => ({ conversationId: "discord:owner", text: "delete it", reply: "Deleted.", origin: "owner", channel: "discord", files: [], ...over });

describe("a turn's answer shown on Discord after an approval", () => {
  it("sends a resumed DM turn's answer back to the DM", async () => {
    const d = deps();
    await postSaid(said({ resumed: true }), d);
    expect(d.dms).toEqual(["Deleted."]);
    expect(d.posts).toEqual([]);
  });

  it("posts a resumed thread turn's answer in its thread, and not in the DM", async () => {
    const d = deps({ "discord:thread:t1": "t1" });
    await postSaid(said({ conversationId: "discord:thread:t1", resumed: true }), d);
    expect(d.posts).toEqual([{ target: "t1", text: "Deleted." }]);
    expect(d.dms).toEqual([]);
  });

  it("leaves a Discord turn that did not wait to the presence that ran it", async () => {
    const d = deps({ "discord:thread:t1": "t1" });
    await postSaid(said({ conversationId: "discord:thread:t1" }), d);
    await postSaid(said({}), d);
    expect(d.posts).toEqual([]);
    expect(d.dms).toEqual([]);
  });

  it("posts the answer of a decision taken after a restart where its chat is mirrored", async () => {
    // Resumed by the decision itself: the harness's turn, with no surface.
    const d = deps({ "discord:thread:t1": "t1" });
    await postSaid(said({ conversationId: "discord:thread:t1", channel: null, origin: "system", text: "System: the owner approved" }), d);
    expect(d.posts).toEqual([{ target: "t1", text: "Deleted." }]);
    expect(d.dms).toEqual([]);
  });
});
