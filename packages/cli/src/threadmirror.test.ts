import { describe, expect, it } from "vitest";

import type { ProgressEvent } from "@kos/harness";
import { ThreadMirror, type Story, type ThreadMirrorDeps } from "./threadmirror.js";

interface Post {
  target: string;
  text: string;
  from?: string;
  files?: number;
}

/** A recording stand-in for the Discord adapter and the kernel facts the mirror reads. */
function harness(over: Partial<ThreadMirrorDeps> = {}) {
  const posts: Post[] = [];
  const edits: string[] = [];
  let storyOpenedIn: string | null = null;
  let removed = false;
  const madeThreads: { key: string; conv: string }[] = [];
  const bound: { threadId: string; conv: string }[] = [];
  let clock = 0;

  const story: Story = {
    edit: async (text) => {
      edits.push(text);
    },
    remove: async () => {
      removed = true;
    },
  };

  const deps: ThreadMirrorDeps = {
    targetFor: (id) => (id === "c-thread" ? "t1" : undefined),
    projectOf: (id) => (id === "c-new" ? "school" : id === "c-thread" ? "school" : undefined),
    ensureThread: async (key, conv) => {
      madeThreads.push({ key, conv });
      return "t-made";
    },
    bindThread: (threadId, conv) => {
      bound.push({ threadId, conv });
    },
    titleOf: (id) => `Title of ${id}`,
    speakerFor: (from) => ({ name: from.name }),
    ownerSender: async () => ({ name: "Owner" }),
    senderFor: (id) => (id === "c-thread" || id === "c-new" ? { name: "Agent" } : undefined),
    filesFor: (files) => files.map((f) => ({ name: f.name, mediaType: "application/octet-stream", data: "", path: f.path })),
    postIn: async (target, msg) => {
      posts.push({ target, text: msg.text ?? "", ...(msg.from ? { from: msg.from.name } : {}), ...(msg.files ? { files: msg.files.length } : {}) });
    },
    openStory: async (target) => {
      storyOpenedIn = target;
      return story;
    },
    now: () => clock,
    narrateEveryMs: 0,
    warn: () => undefined,
    ...over,
  };
  const mirror = new ThreadMirror(deps);
  return { mirror, posts, edits, madeThreads, bound, get storyOpenedIn() { return storyOpenedIn; }, get removed() { return removed; }, tick: () => { clock += 1; } };
}

const start = (conv: string, over: Partial<Extract<ProgressEvent, { kind: "turn-start" }>> = {}): ProgressEvent => ({ kind: "turn-start", conversationId: conv, said: "do the thing", from: "dispatch", origin: { via: "dispatch", from: { kind: "chat", name: "Orchestrator", id: "project:school" } }, ...over });
const toolStart = (conv: string): ProgressEvent => ({ kind: "tool-start", conversationId: conv, tool: "sql", summary: "Reading the roster" });
const toolEnd = (conv: string, isError = false): ProgressEvent => ({ kind: "tool-end", conversationId: conv, tool: "sql", isError });
const turnEnd = (conv: string): ProgressEvent => ({ kind: "turn-end", conversationId: conv });

describe("mirroring a turn's story into a thread", () => {
  it("posts the passed-on message, narrates the step, then the answer, in order", async () => {
    const h = harness();
    h.mirror.onProgress(start("c-thread"));
    await h.mirror.settle();
    // The passed-on message is up first, under the sender's name.
    expect(h.posts).toEqual([{ target: "t1", text: "do the thing\n-# passed on", from: "Orchestrator" }]);
    h.mirror.onProgress(toolStart("c-thread"));
    await h.mirror.settle();
    expect(h.storyOpenedIn).toBe("t1");
    expect(h.edits.at(-1)).toContain("Reading the roster");
    // The answer arrives through onSaid, which also finalizes the story to its steps.
    let fellBack = false;
    h.mirror.onSaid({ conversationId: "c-thread", text: "do the thing", reply: "Done, 12 rows.", origin: "owner", channel: "dispatch" }, async () => { fellBack = true; });
    await h.mirror.settle();
    expect(fellBack).toBe(false);
    expect(h.posts.at(-1)).toEqual({ target: "t1", text: "Done, 12 rows.", from: "Agent" });
    // The order on the thread: passed-on message, then the answer.
    expect(h.posts.map((p) => p.text)).toEqual(["do the thing\n-# passed on", "Done, 12 rows."]);
  });

  it("makes the thread on demand for a chat that has none yet, and binds it", async () => {
    const h = harness();
    h.mirror.onProgress(start("c-new"));
    await h.mirror.settle();
    expect(h.madeThreads).toEqual([{ key: "project:school", conv: "c-new" }]);
    expect(h.bound).toEqual([{ threadId: "t-made", conv: "c-new" }]);
    expect(h.posts[0]?.target).toBe("t-made");
  });

  it("opens no story for a turn that takes no step, and still posts the message and the answer", async () => {
    const h = harness();
    h.mirror.onProgress(start("c-thread"));
    await h.mirror.settle();
    h.mirror.onSaid({ conversationId: "c-thread", text: "do the thing", reply: "No tools needed.", origin: "owner", channel: "dispatch" }, async () => undefined);
    await h.mirror.settle();
    expect(h.storyOpenedIn).toBeNull();
    expect(h.posts.map((p) => p.text)).toEqual(["do the thing\n-# passed on", "No tools needed."]);
  });

  it("posts the owner's own words under their name when the turn is theirs", async () => {
    const h = harness();
    h.mirror.onProgress(start("c-thread", { from: "dashboard", origin: { via: "dashboard" } }));
    await h.mirror.settle();
    expect(h.posts[0]).toEqual({ target: "t1", text: "do the thing", from: "Owner" });
  });

  it("marks a failed step and finalizes the story on turn-end when the turn said nothing", async () => {
    const h = harness();
    h.mirror.onProgress(start("c-thread"));
    h.mirror.onProgress(toolStart("c-thread"));
    h.mirror.onProgress(toolEnd("c-thread", true));
    await h.mirror.settle();
    expect(h.edits.at(-1)).toContain("(failed)");
    // No onSaid for this turn: turn-end closes the story to its steps.
    h.mirror.onProgress(turnEnd("c-thread"));
    await h.mirror.settle();
    expect(h.removed).toBe(false);
    expect(h.edits.at(-1)).toContain("Reading the roster");
  });

  it("leaves a turn from Discord, a scheduled job, and a system turn to the host", async () => {
    const h = harness();
    h.mirror.onProgress(start("c-thread", { from: "discord" }));
    h.mirror.onProgress(start("cron:3", { from: "schedule" }));
    h.mirror.onProgress(start("c-thread", { said: "" }));
    await h.mirror.settle();
    expect(h.posts).toEqual([]);
    // None are tracked, so onSaid falls back to the host for each.
    let backs = 0;
    for (const id of ["c-thread", "cron:3"]) h.mirror.onSaid({ conversationId: id, text: "x", reply: "y", origin: "owner", channel: null }, async () => { backs += 1; });
    await h.mirror.settle();
    expect(backs).toBe(2);
  });
});
