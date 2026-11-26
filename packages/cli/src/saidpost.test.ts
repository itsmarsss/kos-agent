import { describe, expect, it } from "vitest";

import type { OutboundMessage } from "@kos/harness";
import { pingsOwner, placeOf, postRun, postSaid, type JobFacts, type PlaceDeps, type RunDeps, type Said, type SaidDeps } from "./saidpost.js";

function deps(
  targets: Record<string, string> = {},
  over: Partial<SaidDeps & PlaceDeps> = {},
): SaidDeps & PlaceDeps & { posts: { target: string; text: string }[]; dms: string[]; made: { key: string; conv: string; title: string }[]; joined: string[] } {
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
    ownerOnly: () => true,
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

describe("KOS's own words in a mirrored chat", () => {
  it("posts a repair prompt under KOS's name, never the owner's", async () => {
    const d = deps({ "c-fix": "t-fix" });
    const posted: { text: string; from?: string }[] = [];
    d.postIn = async (_target, msg) => void posted.push({ text: msg.text, ...(msg.from ? { from: msg.from.name } : {}) });
    await postSaid(said({ conversationId: "c-fix", text: "KOS maintenance: a scheduled job failed. Fix it.", reply: "Turned it off.", channel: null, from: { kind: "kos", name: "KOS maintenance" } }), d);
    expect(posted).toEqual([{ text: "KOS maintenance: a scheduled job failed. Fix it.", from: "KOS maintenance" }, { text: "Turned it off." }]);
  });
});

describe("a scheduled run on the server", () => {
  const recap: JobFacts = { id: 13, name: "blob.recap", type: "self_prompt", projectSlug: null };
  const nudge: JobFacts = { id: 29, name: "School Evening Nudge", type: "self_prompt", projectSlug: "school" };
  const jobs: Record<number, JobFacts> = { 13: recap, 29: nudge, 9: { id: 9, name: "kos.memory", type: "self_prompt", projectSlug: null } };
  const runDeps = (targets: Record<string, string>, over: Partial<RunDeps> = {}): RunDeps & ReturnType<typeof deps> => ({ ...deps(targets), job: (id) => jobs[id], ...over });
  const ran = (conv: string, reply: string, over: Partial<Said> = {}): Said => ({ conversationId: conv, text: "", reply, origin: "system", channel: null, files: [], from: { kind: "schedule", name: "x", id: "1" }, ...over });

  it("posts the answer of a run that sent nothing, under the job's name, as a recap delivered by its reply", async () => {
    const d = runDeps({ "agent:recap": "c-recap" });
    await postSaid(ran("agent:recap", "This week: shipped three things."), d);
    await postRun({ conversationId: "agent:recap", jobId: 13, reply: "This week: shipped three things.", sent: false }, d);
    expect(d.posts).toEqual([{ target: "c-recap", text: "-# blob.recap\nThis week: shipped three things." }]);
  });

  it("posts once for a run that posted, with no receipt after it, resumed after an approval or not", async () => {
    const d = runDeps({ "cron:29": "t29" });
    await postSaid(ran("cron:29", "Posted to #school."), d);
    await postSaid(ran("cron:29", "Posted to #school.", { resumed: true }), d);
    await postRun({ conversationId: "cron:29", jobId: 29, reply: "Posted to #school.", sent: true }, d);
    // Its one post went to #school through notify; nothing more lands on the server.
    expect(d.posts).toEqual([]);
    expect(d.dms).toEqual([]);
  });

  it("posts nothing for a quiet run, an empty answer, or KOS's upkeep", async () => {
    const d = runDeps({ "cron:62": "t62", "cron:9": "t9" }, { job: (id) => jobs[id] ?? { ...nudge, id } });
    // Said it had nothing to post (a quiet ending is a notify that worked).
    await postRun({ conversationId: "cron:62", jobId: 62, reply: "Nothing new this hour.", sent: true }, d);
    await postRun({ conversationId: "cron:62", jobId: 62, reply: "  ", sent: false }, d);
    await postRun({ conversationId: "cron:9", jobId: 9, reply: "Nothing new to remember.", sent: false }, d);
    expect(d.posts).toEqual([]);
  });

  it("sends a run's answer to the DM when guests can read its place", async () => {
    const d = runDeps({ "cron:29": "t29" }, { ownerOnly: () => false });
    await postRun({ conversationId: "cron:29", jobId: 29, reply: "Nobody posted the board.", sent: false }, d);
    expect(d.posts).toEqual([]);
    expect(d.dms).toEqual(["-# School Evening Nudge\nNobody posted the board."]);
  });

  it("still posts a blob's answer to work a chat passed it", async () => {
    const d = deps({ "agent:watch": "c-watch" });
    await postSaid(ran("agent:watch", "Checked: back in stock.", { from: { kind: "chat", name: "KOS", id: "orchestrator:owner" } }), d);
    expect(d.posts).toEqual([{ target: "c-watch", text: "Checked: back in stock." }]);
  });

  it("still posts an answer after a decision in a job's thread, and what the owner says there", async () => {
    const d = deps({ "cron:29": "t29" });
    // A decision taken after a restart resumes as the harness's own turn, with no schedule behind it.
    await postSaid({ conversationId: "cron:29", text: "System: the owner decided on the pending action:", reply: "Moved to 6 PM.", origin: "system", channel: null, files: [] }, d);
    await postSaid({ conversationId: "cron:29", text: "post it earlier", reply: "Done.", origin: "owner", channel: null, files: [] }, d);
    expect(d.posts).toEqual([
      { target: "t29", text: "Moved to 6 PM." },
      { target: "t29", text: "post it earlier" },
      { target: "t29", text: "Done." },
    ]);
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
