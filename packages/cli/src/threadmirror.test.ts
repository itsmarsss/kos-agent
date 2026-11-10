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
  let storyFrom: string | undefined;
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
    homeOf: (id) => (id === "c-new" || id === "c-thread" ? "project:school" : id === "c-root" ? "orchestrator:owner" : undefined),
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
    openStory: async (target, from) => {
      storyOpenedIn = target;
      storyFrom = from?.name;
      return story;
    },
    now: () => clock,
    narrateEveryMs: 0,
    warn: () => undefined,
    ...over,
  };
  const mirror = new ThreadMirror(deps);
  return { mirror, posts, edits, madeThreads, bound, get storyOpenedIn() { return storyOpenedIn; }, get storyFrom() { return storyFrom; }, get removed() { return removed; }, tick: () => { clock += 1; } };
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
    // Told by whoever answers there, as the answer will be, not by the bot.
    expect(h.storyFrom).toBe("Agent");
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

  it("gives a chat at the root its thread under KOS's channel on first mirror, and a chat with no home none", async () => {
    const h = harness();
    h.mirror.onProgress({ kind: "turn-start", conversationId: "c-root", said: "do the thing", from: "dashboard" });
    h.mirror.onProgress({ kind: "turn-start", conversationId: "c-dm", said: "do the thing", from: "dashboard" });
    await h.mirror.settle();
    expect(h.madeThreads).toEqual([{ key: "orchestrator:owner", conv: "c-root" }]);
    expect(h.posts).toEqual([{ target: "t-made", text: "do the thing", from: "Owner" }]);
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

  it("leaves a turn from Discord, a scheduled run, and a system turn to the host", async () => {
    const h = harness();
    h.mirror.onProgress(start("c-thread", { from: "discord" }));
    // A scheduled run is the harness prompting itself: its turn-start carries no words.
    h.mirror.onProgress({ kind: "turn-start", conversationId: "cron:3" });
    h.mirror.onProgress(start("c-thread", { said: "" }));
    await h.mirror.settle();
    expect(h.posts).toEqual([]);
    // None are tracked, so onSaid falls back to the host for each.
    let backs = 0;
    for (const id of ["c-thread", "cron:3"]) h.mirror.onSaid({ conversationId: id, text: "x", reply: "y", origin: "owner", channel: null }, async () => { backs += 1; });
    await h.mirror.settle();
    expect(backs).toBe(2);
  });

  it("tells what the owner says in a job's thread like any other conversation", async () => {
    const h = harness({ targetFor: (id) => (id === "cron:7" ? "t-job" : undefined) });
    h.mirror.onProgress(start("cron:7", { from: "dashboard", origin: { via: "dashboard" }, said: "why did this say Task 4?" }));
    await h.mirror.settle();
    expect(h.posts[0]).toEqual({ target: "t-job", text: "why did this say Task 4?", from: "Owner" });
    let fellBack = false;
    h.mirror.onSaid({ conversationId: "cron:7", text: "why did this say Task 4?", reply: "Because it was due.", origin: "owner", channel: null }, async () => { fellBack = true; });
    await h.mirror.settle();
    expect(fellBack).toBe(false);
    expect(h.posts.map((p) => p.text)).toEqual(["why did this say Task 4?", "Because it was due."]);
  });
});

describe("a mirrored story kept for a restart", () => {
  it("is let go once the turn's story is told", async () => {
    let closed = 0;
    const story: Story = { edit: async () => undefined, remove: async () => undefined, close: () => void (closed += 1) };
    const h = harness({ openStory: async () => story });
    h.mirror.onProgress(start("c-thread"));
    h.mirror.onProgress(toolStart("c-thread"));
    await h.mirror.settle();
    expect(closed).toBe(0);
    h.mirror.onSaid({ conversationId: "c-thread", text: "do the thing", reply: "Done.", origin: "owner", channel: null }, async () => undefined);
    await h.mirror.settle();
    expect(closed).toBe(1);
  });
});

describe("words steered into a running turn from the dashboard", () => {
  it("posts them in the thread under the owner's name, and leaves Discord's own words alone", async () => {
    const h = harness();
    h.mirror.onProgress({ kind: "heard", conversationId: "c-thread", said: "use the red one", from: "dashboard" });
    h.mirror.onProgress({ kind: "heard", conversationId: "c-thread", said: "said on discord", from: "discord" });
    h.mirror.onProgress({ kind: "heard", conversationId: "c-nowhere", said: "no thread" });
    await h.mirror.settle();
    expect(h.posts).toEqual([{ target: "t1", text: "use the red one", from: "Owner" }]);
  });
});

describe("the owner's own words mirrored into a thread", () => {
  it("go up without a notification, while the answer does notify", async () => {
    const posted: { text: string; silent?: boolean }[] = [];
    const h = harness({ postIn: async (_t, msg) => void posted.push({ text: msg.text, ...(msg.silent ? { silent: true } : {}) }) });
    h.mirror.onProgress(start("c-thread", { from: "dashboard", origin: undefined }));
    h.mirror.onProgress({ kind: "heard", conversationId: "c-thread", said: "and the red one", from: "dashboard" });
    h.mirror.onSaid({ conversationId: "c-thread", text: "do the thing", reply: "Done.", origin: "owner", channel: null }, async () => undefined);
    await h.mirror.settle();
    expect(posted).toEqual([{ text: "do the thing", silent: true }, { text: "and the red one", silent: true }, { text: "Done." }]);
  });
});
