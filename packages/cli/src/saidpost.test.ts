import { describe, expect, it } from "vitest";

import type { OutboundMessage } from "@kos/harness";
import { pingsOwner, placeOf, postSaid, type JobFacts, type Said, type SaidDeps } from "./saidpost.js";

function deps(
  targets: Record<string, string> = {},
  over: Partial<SaidDeps> = {},
): SaidDeps & { posts: { target: string; text: string }[]; dms: string[]; made: { key: string; conv: string; title: string }[]; joined: string[] } {
  const posts: { target: string; text: string }[] = [];
  const dms: string[] = [];
  const made: { key: string; conv: string; title: string }[] = [];
  const joined: string[] = [];
  return {
    joined,
    posts,
    dms,
    made,
    targetFor: (conv) => targets[conv],
    homeOf: () => undefined,
    titleOf: (conv) => `Title of ${conv}`,
    jobOf: () => undefined,
    ownerOnly: () => true,
    saidItsPiece: () => false,
    ensureThread: async (key, conv, title) => {
      made.push({ key, conv, title });
      return `thread-${conv}`;
    },
    joinOwner: async (id) => {
      joined.push(id);
      return true;
    },
    forgetPlace: () => undefined,
    connected: () => true,
    postWhenFound: async () => undefined,
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

describe("a turn's answer in a place guests read", () => {
  it("posts no turn taken elsewhere, and still the answers to what was said there", async () => {
    const open = (over: Partial<SaidDeps> = {}) => deps({ "chat-board": "c1" }, { ownerOnly: (conv) => conv !== "chat-board", ...over });
    const dashboard = open();
    await postSaid(said({ conversationId: "chat-board", channel: "dashboard", text: "my private plan" }), dashboard);
    await postSaid(said({ conversationId: "chat-board", channel: null, from: { kind: "chat", name: "Orchestrator", id: "project:x" } }), dashboard);
    expect(dashboard.posts).toEqual([]);
    expect(dashboard.dms).toEqual([]);
    // Asked there and answered after an approval: the answer lands there.
    const resumed = open();
    await postSaid(said({ conversationId: "chat-board", resumed: true }), resumed);
    expect(resumed.posts).toEqual([{ target: "c1", text: "Deleted." }]);
  });
});

describe("a scheduled run's answer on the server", () => {
  const kickoff: JobFacts = { id: 2, name: "9 AM Daily Kickoff", type: "self_prompt", projectSlug: null };
  const reminder: JobFacts = { id: 7, name: "Nudge", type: "actions", projectSlug: null };
  const run = (conv: string, reply = "Kickoff sent."): Said => ({ conversationId: conv, text: "", reply, origin: "system", channel: null, files: [] });
  const failedRun = (conv: string): Said => ({ ...run(conv, "Ran 2 actions; 1 failed."), failed: true });

  it("posts nothing for a run that sent nothing, and makes no thread for it", async () => {
    const d = deps({ "orchestrator:owner": "kos" }, { jobOf: () => kickoff, homeOf: () => "orchestrator:owner" });
    await postSaid(run("cron:62", "I'll run the scanner. Nothing new this hour. Nothing sent."), d);
    await postSaid({ ...run("cron:21", "The update changed 0 rows."), from: { kind: "schedule", name: "Backfill", id: "21" } }, d);
    expect(d.posts).toEqual([]);
    expect(d.dms).toEqual([]);
    expect(d.made).toEqual([]);
  });

  it("posts nothing for a blob's scheduled run that sent nothing", async () => {
    const d = deps({ "agent:watch": "c-watch" });
    await postSaid({ ...run("agent:watch", "Nothing changed, no notification sent."), from: { kind: "schedule", name: "blob.watch", id: "17" } }, d);
    expect(d.posts).toEqual([]);
    expect(d.dms).toEqual([]);
  });

  it("still posts a blob's answer to work a chat passed it", async () => {
    const d = deps({ "agent:watch": "c-watch" });
    await postSaid({ ...run("agent:watch", "Checked: back in stock."), from: { kind: "chat", name: "KOS", id: "orchestrator:owner" } }, d);
    expect(d.posts).toEqual([{ target: "c-watch", text: "Checked: back in stock." }]);
  });

  it("posts a root job's failed run in a thread of its own made under KOS's channel", async () => {
    const d = deps({ "orchestrator:owner": "kos" }, { jobOf: () => reminder, homeOf: () => "orchestrator:owner" });
    await postSaid(failedRun("cron:7"), d);
    expect(d.made).toEqual([{ key: "orchestrator:owner", conv: "cron:7", title: "Title of cron:7" }]);
    expect(d.posts).toEqual([{ target: "thread-cron:7", text: "-# Nudge\nRan 2 actions; 1 failed." }]);
    expect(d.joined).toEqual(["thread-cron:7"]);
    expect(d.dms).toEqual([]);
  });

  it("sends a failed run to the DM when guests can read its place", async () => {
    const d = deps({ "cron:7": "t7" }, { jobOf: () => reminder, ownerOnly: () => false });
    await postSaid(failedRun("cron:7"), d);
    expect(d.posts).toEqual([]);
    expect(d.dms).toEqual(["-# Nudge\nRan 2 actions; 1 failed."]);
  });

  it("keeps KOS's upkeep runs to themselves, failed or not", async () => {
    const d = deps({ "orchestrator:owner": "kos" }, { jobOf: () => ({ id: 1, name: "kos.backup", type: "actions", projectSlug: null }), homeOf: () => "orchestrator:owner" });
    await postSaid(failedRun("cron:1"), d);
    expect(d.posts).toEqual([]);
    expect(d.made).toEqual([]);
  });

  it("still tells a run's failure after it said its piece in its place", async () => {
    const d = deps({ "cron:7": "t7" }, { jobOf: () => reminder, saidItsPiece: () => true });
    await postSaid(failedRun("cron:7"), d);
    expect(d.posts).toEqual([{ target: "t7", text: "-# Nudge\nRan 2 actions; 1 failed." }]);
  });

  it("does not repeat a run that already said its piece in its place", async () => {
    const d = deps({ "cron:24": "t24", "agent:briefing": "c-brief" }, { jobOf: (c) => (c === "cron:24" ? { ...kickoff, id: 24, name: "School Morning Digest", projectSlug: "school" } : undefined), saidItsPiece: () => true });
    await postSaid(run("cron:24", "Digest sent."), d);
    await postSaid(run("agent:briefing", "Brief sent."), d);
    expect(d.posts).toEqual([]);
  });
});

describe("a conversation's place on the server", () => {
  it("is its own channel or thread when it has one, with the owner made a member of it", async () => {
    const d = deps({ "cron:7": "t7" });
    expect(await placeOf("cron:7", d)).toEqual({ id: "t7", heard: true });
    expect(d.joined).toEqual(["t7"]);
  });

  it("falls back to its home's channel when no thread can be made, and is nothing without a home", async () => {
    const d = deps({ "project:school": "school" }, { homeOf: (c) => (c === "cron:24" ? "project:school" : undefined), ensureThread: async () => undefined });
    expect(await placeOf("cron:24", d)).toEqual({ id: "school", heard: true });
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
