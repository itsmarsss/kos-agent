import { describe, expect, it } from "vitest";

import { autoMarked, LiveStory, type StoryPayload, type StoryPost } from "./discordstory.js";

/** A story message on a fake Discord: its edits, and whether it was taken down. */
function fakePost(content: string, log: { posts: { content: string; edits: StoryPayload[]; removed: boolean }[] }, hold?: () => Promise<void>): StoryPost {
  const post = { content, edits: [] as StoryPayload[], removed: false };
  log.posts.push(post);
  return {
    edit: async (payload) => {
      await hold?.();
      post.edits.push(payload);
      post.content = payload.content;
    },
    remove: async () => void (post.removed = true),
  };
}

/** A clock the story waits on, moved by hand. */
function clock(): { now: () => number; sleep: (ms: number) => Promise<void>; slept: number[] } {
  let at = 0;
  const slept: number[] = [];
  return {
    now: () => at,
    sleep: async (ms) => {
      slept.push(ms);
      at += ms;
    },
    slept,
  };
}

describe("a live story", () => {
  it("draws only the newest state of what came while an edit was in flight", async () => {
    const log = { posts: [] as { content: string; edits: StoryPayload[]; removed: boolean }[] };
    let release!: () => void;
    let held = true;
    const gate = (): Promise<void> => (held ? new Promise<void>((r) => (release = r)) : Promise.resolve());
    const time = clock();
    const story = new LiveStory(fakePost("thinking", log, gate), { render: (r) => r, next: async () => undefined, gapMs: 1000, ...time });
    const first = story.update("one");
    await Promise.resolve();
    // While "one" is being drawn, three more states arrive.
    void story.update("two");
    void story.update("three");
    const last = story.update("four");
    held = false;
    release();
    await Promise.all([first, last]);
    expect(log.posts[0]!.edits.map((e) => e.content)).toEqual(["one", "four"]);
    // The second edit waited out the gap after the first.
    expect(time.slept).toEqual([1000]);
  });

  it("waits out a rate limit Discord answered with, then draws the newest", async () => {
    const log = { posts: [] as { content: string; edits: StoryPayload[]; removed: boolean }[] };
    const time = clock();
    let refusals = 1;
    const post: StoryPost = {
      edit: async (payload) => {
        if (refusals-- > 0) throw Object.assign(new Error("limited"), { name: "RateLimitError", retryAfter: 4000 });
        log.posts[0]!.edits.push(payload);
      },
      remove: async () => undefined,
    };
    log.posts.push({ content: "", edits: [], removed: false });
    const story = new LiveStory(post, { render: (r) => r, next: async () => undefined, gapMs: 1000, ...time });
    await story.update("one");
    expect(log.posts[0]!.edits.map((e) => e.content)).toEqual(["one"]);
    expect(time.slept).toEqual([4000]);
  });

  it("rolls onto a new message when it outgrows one, never past a step still running", async () => {
    const log = { posts: [] as { content: string; edits: StoryPayload[]; removed: boolean }[] };
    const story = new LiveStory(fakePost("thinking", log), {
      render: (r) => r,
      next: async (content) => fakePost(content, log),
      limit: 45,
      gapMs: 0,
      ...clock(),
    });
    await story.update(["› step one · 1.0s", "› step two · 4s so far", "› step three"].join("\n"));
    expect(log.posts).toHaveLength(2);
    expect(log.posts[0]!.content).toBe("› step one · 1.0s");
    // The running step went on in the new message, where its time can still change.
    expect(log.posts[1]!.content).toBe("› step two · 4s so far\n› step three");
    await story.update(["› step one · 1.0s", "› step two · 6.0s"].join("\n"));
    expect(log.posts[1]!.content).toBe("› step two · 6.0s");
    expect(log.posts[0]!.content).toBe("› step one · 1.0s");
    // Taken down whole.
    await story.remove();
    expect(log.posts.every((p) => p.removed)).toBe(true);
  });

  it("never rolls past a step running for minutes or hours", async () => {
    for (const so of ["2m 05s", "1h 02m"]) {
      const log = { posts: [] as { content: string; edits: StoryPayload[]; removed: boolean }[] };
      const story = new LiveStory(fakePost("thinking", log), { render: (r) => r, next: async (content) => fakePost(content, log), limit: 50, gapMs: 0, ...clock() });
      await story.update(["› step one · 1.0s", `› step two · ${so} so far`, "› step three"].join("\n"));
      expect(log.posts[0]!.content, so).toBe("› step one · 1.0s");
      expect(log.posts[1]!.content, so).toBe(`› step two · ${so} so far\n› step three`);
    }
  });

  it("keeps the first message whole when the next could not be posted, and tries again", async () => {
    const log = { posts: [] as { content: string; edits: StoryPayload[]; removed: boolean }[] };
    let refuse = true;
    const story = new LiveStory(fakePost("thinking", log), {
      render: (r) => r,
      next: async (content) => (refuse ? undefined : fakePost(content, log)),
      limit: 45,
      gapMs: 0,
      ...clock(),
    });
    await story.update(["› step one · 1.0s", "› step two · 2.0s", "› step three"].join("\n"));
    expect(log.posts).toHaveLength(1);
    expect(log.posts[0]!.content).toBe("› step one · 1.0s\n› step two · 2.0s");
    refuse = false;
    await story.update(["› step one · 1.0s", "› step two · 2.0s", "› step three · 3.0s"].join("\n"));
    expect(log.posts[0]!.content).toBe("› step one · 1.0s\n› step two · 2.0s");
    expect(log.posts[1]!.content).toBe("› step three · 3.0s");
  });

  it("shows the newest step's picture as a thumbnail, sent again only when it changes, and only where allowed", async () => {
    const log = { posts: [] as { content: string; edits: StoryPayload[]; removed: boolean }[] };
    const story = new LiveStory(fakePost("t", log), { render: (r) => r, next: async () => undefined, pictures: true, gapMs: 0, ...clock() });
    const picture = { id: 4, image: Buffer.from("JPEG").toString("base64") };
    await story.update("› Click", { picture });
    await story.update("› Click · 0.4s", { picture });
    const [withPicture, without] = log.posts[0]!.edits;
    expect(withPicture?.embeds).toEqual([{ thumbnail: { url: "attachment://step.jpg" } }]);
    expect(withPicture?.files?.[0]?.attachment.toString()).toBe("JPEG");
    expect(without?.files).toBeUndefined();
    const guarded = { posts: [] as { content: string; edits: StoryPayload[]; removed: boolean }[] };
    const shared = new LiveStory(fakePost("t", guarded), { render: (r) => r, next: async () => undefined, pictures: false, gapMs: 0, ...clock() });
    await shared.update("› Click", { picture });
    expect(guarded.posts[0]!.edits[0]?.files).toBeUndefined();
  });

  it("starts with (Auto) when the chat is in Auto", async () => {
    const log = { posts: [] as { content: string; edits: StoryPayload[]; removed: boolean }[] };
    const story = new LiveStory(fakePost("t", log), { render: (r) => r, next: async () => undefined, gapMs: 0, ...clock() });
    await story.update("Looking.\n-# › Read a", { auto: true });
    expect(log.posts[0]!.content).toBe("(Auto) Looking.\n-# › Read a");
    expect(autoMarked("-# › Read a")).toBe("-# (Auto) › Read a");
  });
});

describe("a turn's story in a Discord room", () => {
  async function storyIn(guild: boolean): Promise<{ edits: Record<string, unknown>[]; sent: Record<string, unknown>[] }> {
    const { DiscordAdapter } = await import("./discord.js");
    const adapter = new DiscordAdapter({ token: "t" });
    const edits: Record<string, unknown>[] = [];
    const sent: Record<string, unknown>[] = [];
    const channel = {
      id: "c1",
      ...(guild ? { guildId: "g1", permissionOverwrites: { cache: new Map() } } : {}),
      send: async (p: Record<string, unknown>) => {
        sent.push(p);
        return { id: `m${sent.length}`, edit: async (e: Record<string, unknown>) => void edits.push(e), delete: async () => undefined };
      },
    };
    const presence = await adapter.acknowledge({ channel: "discord", senderId: "o", text: "hi", native: { channel, guild: guild ? { id: "g1" } : null } });
    await presence!.update("› Click Pay", { picture: { id: 1, image: Buffer.from("JPEG").toString("base64") }, auto: true });
    await presence!.complete({ text: "Paid." });
    return { edits, sent };
  }

  it("shows the step's picture in the owner's DM, marked Auto, and posts the answer as its own message", async () => {
    const { edits, sent } = await storyIn(false);
    expect(edits[0]?.content).toBe("-# (Auto) › Click Pay");
    expect((edits[0]?.files as { name: string }[])[0]?.name).toBe("step.jpg");
    expect(sent.map((s) => s.content)).toEqual(["-# thinking…", "Paid."]);
  });

  it("shows no picture where others read", async () => {
    const { edits } = await storyIn(true);
    expect(edits[0]?.files).toBeUndefined();
  });
});

describe("times on Discord, which stamps every message itself", () => {
  it("adds no day or clock line to a story or its answer, only how long steps took", async () => {
    const { DiscordAdapter } = await import("./discord.js");
    const adapter = new DiscordAdapter({ token: "t", timezone: "America/Toronto" });
    const said: string[] = [];
    const channel = { id: "dm", send: async (p: { content: string }) => (said.push(p.content), { id: `m${said.length}`, edit: async (e: { content: string }) => void said.push(e.content), delete: async () => undefined }) };
    const presence = await adapter.acknowledge({ channel: "discord", senderId: "o", text: "hi", native: { channel, guild: null } });
    await presence!.update("Looking.\n› Read a · 1.2s\n› Read b · 4s so far");
    await presence!.complete({ text: "Two files." });
    const all = said.join("\n");
    expect(all).not.toMatch(/\b(Today|Yesterday)\b/);
    expect(all).not.toMatch(/\b\d{1,2}:\d{2}\b/);
    expect(all).not.toMatch(/<t:\d+:[tTfFdD]>/);
    expect(said.at(-1)).toBe("Two files.");
  });
});
