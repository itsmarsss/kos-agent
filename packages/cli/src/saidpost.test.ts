import { describe, expect, it } from "vitest";

import type { OutboundMessage } from "@kos/harness";
import { pingsOwner, placeOf, postSaid, type JobFacts, type Said, type SaidDeps } from "./saidpost.js";

function deps(
  targets: Record<string, string> = {},
  over: Partial<SaidDeps> = {},
): SaidDeps & { posts: { target: string; text: string }[]; dms: string[]; made: { key: string; conv: string; title: string }[]; bound: [string, string][]; joined: string[] } {
  const posts: { target: string; text: string }[] = [];
  const dms: string[] = [];
  const made: { key: string; conv: string; title: string }[] = [];
  const bound: [string, string][] = [];
  const joined: string[] = [];
  return {
    joined,
    posts,
    dms,
    made,
    bound,
    targetFor: (conv) => targets[conv],
    homeOf: () => undefined,
    titleOf: (conv) => `Title of ${conv}`,
    jobOf: () => undefined,
    spokeInPlace: () => false,
    ensureThread: async (key, conv, title) => {
      made.push({ key, conv, title });
      return `thread-${conv}`;
    },
    bindThread: (thread, conv) => void bound.push([thread, conv]),
    joinOwner: async (id) => void joined.push(id),
    forgetPlace: () => undefined,
    senderFor: () => undefined,
    speakerFor: (from) => ({ name: from.name }),
    ownerSender: async () => ({ name: "Owner" }),
    filesFor: () => [],
    postIn: async (target, msg: OutboundMessage) => void posts.push({ target, text: msg.text }),
    sendOwner: async (msg) => void dms.push(msg.text),
    ...over,
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

  it("sends a resumed DM turn's answer back to the DM even when its chat has a thread", async () => {
    const d = deps({ "chat-1": "t1" });
    await postSaid(said({ conversationId: "chat-1", resumed: true, dm: true }), d);
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

describe("a scheduled run's answer on the server", () => {
  const kickoff: JobFacts = { id: 2, name: "9 AM Daily Kickoff", type: "self_prompt", projectSlug: null };
  const run = (conv: string, reply = "Kickoff sent."): Said => ({ conversationId: conv, text: "", reply, origin: "system", channel: null, files: [] });

  it("posts a root job's run in a thread of its own made under KOS's channel", async () => {
    const d = deps({ "orchestrator:owner": "kos" }, { jobOf: () => kickoff, homeOf: () => "orchestrator:owner" });
    await postSaid(run("cron:2"), d);
    expect(d.made).toEqual([{ key: "orchestrator:owner", conv: "cron:2", title: "Title of cron:2" }]);
    expect(d.bound).toEqual([["thread-cron:2", "cron:2"]]);
    expect(d.posts).toEqual([{ target: "thread-cron:2", text: "-# 9 AM Daily Kickoff\nKickoff sent." }]);
    expect(d.joined).toEqual(["thread-cron:2"]);
    expect(d.dms).toEqual([]);
  });

  it("keeps KOS's upkeep runs to themselves", async () => {
    const d = deps({ "orchestrator:owner": "kos" }, { jobOf: () => ({ id: 11, name: "kos.observe", type: "self_prompt", projectSlug: null }), homeOf: () => "orchestrator:owner" });
    await postSaid(run("cron:11", "No threads needed observing."), d);
    expect(d.posts).toEqual([]);
    expect(d.made).toEqual([]);
  });

  it("still tells a run's failure after it said its piece in its place", async () => {
    const reminder: JobFacts = { id: 7, name: "Nudge", type: "actions", projectSlug: null };
    const d = deps({ "cron:7": "t7" }, { jobOf: () => reminder, spokeInPlace: () => true });
    await postSaid({ ...run("cron:7", "Ran 2 actions; 1 failed."), failed: true }, d);
    expect(d.posts).toEqual([{ target: "t7", text: "-# Nudge\nRan 2 actions; 1 failed." }]);
  });

  it("does not repeat a run that already said its piece in its place", async () => {
    const d = deps({ "cron:24": "t24", "agent:briefing": "c-brief" }, { jobOf: (c) => (c === "cron:24" ? { ...kickoff, id: 24, name: "School Morning Digest", projectSlug: "school" } : undefined), spokeInPlace: () => true });
    await postSaid(run("cron:24", "Digest sent."), d);
    await postSaid(run("agent:briefing", "Brief sent."), d);
    expect(d.posts).toEqual([]);
  });
});

describe("a conversation's place on the server", () => {
  it("is its own channel or thread when it has one, with the owner made a member of it", async () => {
    const d = deps({ "cron:7": "t7" });
    expect(await placeOf("cron:7", d)).toBe("t7");
    expect(d.joined).toEqual(["t7"]);
  });

  it("falls back to its home's channel when no thread can be made, and is nothing without a home", async () => {
    const d = deps({ "project:school": "school" }, { homeOf: (c) => (c === "cron:24" ? "project:school" : undefined), ensureThread: async () => undefined });
    expect(await placeOf("cron:24", d)).toBe("school");
    expect(await placeOf("discord:owner", d)).toBeUndefined();
  });
});

describe("who a job's message pings", () => {
  it("pings the owner for a fixed reminder, not for a prompted run or KOS's upkeep", () => {
    expect(pingsOwner({ name: "OSAP: call The Centre 10:00", type: "actions" })).toBe(true);
    expect(pingsOwner({ name: "9 AM Daily Kickoff", type: "self_prompt" })).toBe(false);
    expect(pingsOwner({ name: "kos.backup", type: "actions" })).toBe(false);
  });
});
