import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { SurfaceDownError, type ChannelAdapter, type NotifyPayload } from "@kos/harness";

import { dashboardUrlFor, PlaceNotifier, roomCursorsIn, surfaceUp, waitForPortFree, type PlaceNotifierDeps } from "./host.js";
import type { JobFacts } from "./saidpost.js";

describe("waitForPortFree", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise((r) => server!.close(() => r(null)));
    server = undefined;
  });

  it("returns immediately when nothing is listening", async () => {
    // 4498 is not bound by anything in this suite.
    expect(await waitForPortFree("127.0.0.1", 4498, 1000)).toBe(true);
  });

  it("reports a held port as not free within the timeout", async () => {
    server = createServer();
    await new Promise((r) => server!.listen(4499, "127.0.0.1", () => r(null)));
    // This is the race a restart has to survive: the old host still holds it.
    expect(await waitForPortFree("127.0.0.1", 4499, 600)).toBe(false);
  });

  it("returns true once the holder lets go", async () => {
    server = createServer();
    await new Promise((r) => server!.listen(4497, "127.0.0.1", () => r(null)));
    setTimeout(() => server?.close(), 200);
    expect(await waitForPortFree("127.0.0.1", 4497, 4000)).toBe(true);
  });
});

describe("surfaceUp", () => {
  const adapter = (connected: boolean): ChannelAdapter => ({ name: "discord", connected: () => connected } as unknown as ChannelAdapter);

  it("hands back a surface that is wired and up", () => {
    const up = adapter(true);
    expect(surfaceUp(new Map([["discord", () => up]]), "discord", false)).toBe(up);
  });

  it("takes the surface-down path for one wired but dropped, rather than sending into it", () => {
    const surfaces = new Map<string, () => ChannelAdapter | undefined>([["discord", () => adapter(false)], ["sms", () => adapter(true)]]);
    expect(() => surfaceUp(surfaces, "discord", false)).toThrow(SurfaceDownError);
    expect(() => surfaceUp(surfaces, "discord", false)).toThrow(/Connected: sms/);
  });

  it("refuses a surface that is not wired here at all", () => {
    expect(() => surfaceUp(new Map(), "telegram", true)).toThrow(/no telegram surface here/);
  });
});

describe("roomCursorsIn", () => {
  it("keeps each room's last message, moving only forward", () => {
    const store = new Map<string, unknown>();
    const settings = { get: <T,>(k: string) => store.get(k) as T | undefined, set: (k: string, v: unknown) => void store.set(k, v) };
    const cursors = roomCursorsIn(settings);
    cursors.advance("dm1", "1000000000000000002");
    cursors.advance("dm1", "999999999999999999");
    cursors.advance("t1", "5");
    expect(cursors.get("dm1")).toBe("1000000000000000002");
    expect(cursors.rooms()).toEqual(["dm1", "t1"]);
    cursors.drop("t1");
    expect(cursors.rooms()).toEqual(["dm1"]);
  });
});

describe("dashboardUrlFor", () => {
  it("links to the public URL when there is one, and to this host otherwise", () => {
    const was = process.env.KOS_PUBLIC_URL;
    try {
      process.env.KOS_PUBLIC_URL = "https://kos.example";
      expect(dashboardUrlFor("127.0.0.1", 4317)).toBe("https://kos.example");
      delete process.env.KOS_PUBLIC_URL;
      expect(dashboardUrlFor("0.0.0.0", 4317)).toBe("http://localhost:4317");
    } finally {
      if (was === undefined) delete process.env.KOS_PUBLIC_URL;
      else process.env.KOS_PUBLIC_URL = was;
    }
  });
});

describe("a scheduled run's message in its place", () => {
  const reminder: JobFacts = { id: 7, name: "OSAP: call The Centre", type: "actions", projectSlug: null };
  const kickoff: JobFacts = { id: 2, name: "9 AM Daily Kickoff", type: "self_prompt", projectSlug: null };

  function placer(over: Partial<PlaceNotifierDeps> = {}) {
    const posts: { target: string; text: string }[] = [];
    const joined: string[] = [];
    const deps: PlaceNotifierDeps = {
      ownerId: "222",
      targetFor: (conv) => ({ "cron:7": "t7", "cron:2": "t2" })[conv],
      homeOf: () => undefined,
      titleOf: (conv) => conv,
      ensureThread: async () => undefined,
      bindThread: () => undefined,
      joinOwner: async (id) => void joined.push(id),
      forgetPlace: () => undefined,
      jobOf: (p) => ({ "cron:7": reminder, "cron:2": kickoff })[p.place ?? ""],
      ownerOnly: () => true,
      postIn: async (target, msg) => void posts.push({ target, text: msg.text }),
      ...over,
    };
    return { notifier: new PlaceNotifier(deps), posts, joined };
  }
  const run = (place: string, text = "Call The Centre now."): NotifyPayload => ({ text, target: { kind: "owner" }, place });

  it("posts in the run's place, pinging the owner for a fixed reminder and not for a prompted run", async () => {
    const { notifier, posts, joined } = placer();
    expect(await notifier.say(run("cron:7"), { text: "Call The Centre now." })).toMatchObject({ delivered: expect.stringContaining("pinging them") });
    await notifier.say(run("cron:2", "Kickoff"), { text: "Kickoff" });
    expect(posts).toEqual([
      { target: "t7", text: "<@222> Call The Centre now." },
      { target: "t2", text: "Kickoff" },
    ]);
    // The owner is a member of each, so the post reaches them as the DM did.
    expect(joined).toEqual(["t7", "t2"]);
  });

  it("pings the owner for a failing job's news in its place, and not for its recovery", async () => {
    const { notifier, posts } = placer();
    await notifier.say({ ...run("cron:2", "Kickoff is failing."), ping: true }, { text: "Kickoff is failing." });
    await notifier.say(run("cron:2", "Kickoff is working again."), { text: "Kickoff is working again." });
    expect(posts.map((p) => p.text)).toEqual(["<@222> Kickoff is failing.", "Kickoff is working again."]);
  });

  it("finds a new place once when Discord says the thread is gone, and leaves it to the DM when that fails too", async () => {
    const bindings: Record<string, string> = { t7: "cron:7" };
    const gone = new Set(["t7"]);
    const { notifier, posts } = placer({
      targetFor: (conv) => Object.entries(bindings).find(([, c]) => c === conv)?.[0],
      homeOf: () => "orchestrator:owner",
      ensureThread: async () => "t8",
      bindThread: (thread, conv) => void (bindings[thread] = conv),
      forgetPlace: (id) => void delete bindings[id],
      postIn: async (target, msg) => {
        if (gone.has(target)) throw Object.assign(new Error("Unknown Channel"), { code: 10003 });
        posts.push({ target, text: msg.text });
      },
    });
    expect(await notifier.say(run("cron:7"), { text: "Call The Centre now." })).toBeDefined();
    expect(posts).toEqual([{ target: "t8", text: "<@222> Call The Centre now." }]);
    expect(bindings).toEqual({ t8: "cron:7" });
    gone.add("t8");
    expect(await notifier.say(run("cron:7"), { text: "Again." })).toBeUndefined();
    expect(notifier.spokeInPlace("cron:7")).toBe(true);
  });

  it("leaves to the owner's DM a run whose place guests can read", async () => {
    const { notifier, posts } = placer({ ownerOnly: (conv) => conv !== "cron:7" });
    expect(await notifier.say(run("cron:7"), { text: "Call The Centre now." })).toBeUndefined();
    expect(await notifier.say(run("cron:2", "Kickoff"), { text: "Kickoff" })).toBeDefined();
    expect(posts).toEqual([{ target: "t2", text: "Kickoff" }]);
  });

  it("leaves to the owner's DM what names somewhere, asks no place, or has none", async () => {
    const { notifier, posts } = placer();
    expect(await notifier.say({ text: "x", target: { kind: "owner" } }, { text: "x" })).toBeUndefined();
    expect(await notifier.say({ text: "x", target: { kind: "owner", surface: "discord" }, place: "cron:7" }, { text: "x" })).toBeUndefined();
    expect(await notifier.say(run("cron:99"), { text: "x" })).toBeUndefined();
    expect(posts).toEqual([]);
  });

  it("remembers a run that spoke in its place until asked, or until its next turn starts", async () => {
    const { notifier } = placer();
    await notifier.say(run("cron:7"), { text: "x" });
    expect(notifier.spokeInPlace("cron:7")).toBe(true);
    expect(notifier.spokeInPlace("cron:7")).toBe(false);
    await notifier.say(run("cron:7"), { text: "x" });
    notifier.turnStarted("cron:7");
    expect(notifier.spokeInPlace("cron:7")).toBe(false);
  });
});
