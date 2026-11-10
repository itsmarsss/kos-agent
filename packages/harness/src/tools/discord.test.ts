import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { guested } from "../kernel/caller.js";
import { ModuleLoader, toolRegistryContext } from "../modules/loader.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Workspace } from "../store/workspace.js";
import { createDiscordModule, findChannel, type Access, type BoundThread, type MakePlace, type ServerChannel, type ServerPlace, type ServerRole } from "./discord.js";

describe("the discord tools", () => {
  let root: string;
  let ws: Workspace;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-discord-tools-"));
    ws = Workspace.open(root);
  });
  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function harness(connected = true, scope?: string, caller?: string) {
    const channels: ServerChannel[] = [
      { key: "orchestrator:owner", id: "ch1", name: "kos", audience: "owner", fixed: true },
      { key: "needs-you", id: "ch2", name: "needs-you", audience: "owner", fixed: true },
      { key: "project:garden", id: "ch3", name: "my-garden", audience: "owner" },
      { key: "agent:recap", id: "ch4", name: "recap", audience: "owner" },
    ];
    const synced: number[] = [];
    const places: ServerPlace[] = [
      { id: "c0", name: "general", kind: "channel", audience: "everyone" },
      { id: "c7", name: "diary", kind: "channel", audience: "owner" },
      // A channel of the owner's made the home of a chat in the garden, not of the project itself.
      { id: "c8", name: "board", kind: "channel", audience: "guests", bound: "chat-board" },
    ];
    const projects: Record<string, string> = { "chat-board": "garden", "cron:21": "garden", "chat-other": "garden", "chat-pantry": "pantry" };
    const roles: ServerRole[] = [{ id: "r0", name: "Members", members: 3 }];
    const made: MakePlace[] = [];
    const accessed: [string, Access[]][] = [];
    const reacted: [string, string, string][] = [];
    const bound: [string, string][] = [];
    const threads: BoundThread[] = [
      { id: "t1", name: "Seeds", channel: "project:garden", conversationId: "c1", projectSlug: "garden", gone: false },
      { id: "t2", name: "(chat deleted)", channel: "project:garden", conversationId: "c2", projectSlug: "garden", gone: true },
      { id: "t3", name: "Loose", channel: "orchestrator:owner", conversationId: "c3", projectSlug: null, gone: false },
      { id: "t4", name: "(chat deleted)", channel: "project:pantry", conversationId: "c4", projectSlug: "pantry", gone: true },
    ];
    const pruned: string[] = [];
    const registry = new ToolRegistry();
    const ctx = toolRegistryContext(registry, {
      workspace: ws,
      db: ws.db,
      secrets: new SecretsRegistry(),
      projectOf: (id) => projects[id],
      ...(scope ? { callerProject: () => scope } : {}),
      ...(caller ? { callerConversation: () => caller } : {}),
    });
    await new ModuleLoader(ctx).load([
      createDiscordModule({
        connected: () => connected,
        channels: async () => channels,
        setAudience: async (key, audience) => {
          const c = channels.find((x) => x.key === key)!;
          c.audience = audience;
          return c;
        },
        setListen: async (key, listen) => {
          const c = channels.find((x) => x.key === key)!;
          if (listen === "mention") c.listen = listen;
          else delete c.listen;
          return c;
        },
        sync: async () => {
          synced.push(1);
          return { created: synced.length === 1 ? ["verity"] : [], kept: ["kos"], threads: synced.length === 1 ? 2 : 0 };
        },
        server: async () => ({ places, roles }),
        known: () => places.filter((p) => p.kind === "channel"),
        threads: () => threads,
        prune: async (ids) => {
          pruned.push(...ids);
          return ids;
        },
        make: async (input) => {
          made.push(input);
          const place = { id: `p${made.length}`, name: input.name, kind: input.kind, ...(input.category ? { category: input.category } : {}) };
          places.push(place);
          return place;
        },
        createRole: async (name, colour) => {
          const role = { id: `r${roles.length + 1}`, name, ...(colour ? { colour } : {}), members: 0 };
          roles.push(role);
          return role;
        },
        setAccess: async (place, access) => {
          const found = places.find((p) => p.name === place || p.id === place);
          if (!found) throw new Error(`no channel or category called ${place}`);
          accessed.push([place, access]);
          return found;
        },
        bind: async (channel, to) => {
          bound.push([channel, to]);
          return { key: to, name: channel.replace(/^#/, ""), audience: "guests" };
        },
        react: async (channel, message, emoji) => {
          // Judged by the tool, a channel comes by id alone.
          reacted.push([typeof channel === "string" ? channel : `id:${channel.id}`, message, emoji]);
        },
        reactions: async () => [{ emoji: "👍", count: 2, users: [{ id: "u1", name: "Ana" }, { id: "u2", name: "Bo" }] }],
        messages: async (_channel, limit) => [{ id: "m1", author: { id: "u1", name: "Ana", bot: false }, text: "done", at: "2026-10-19T09:00:00.000Z", reactions: [] }].slice(0, limit),
        member: async (id) => {
          if (id !== "306") throw new Error(`no member ${id} on the server`);
          return { id, name: "splattertron", displayName: "Splat", bot: false, joinedAt: null, roles: ["Members"] };
        },
      }),
    ]);
    const call = async (name: string, input: Record<string, unknown> = {}) => {
      const res = await registry.execute(name, input);
      return { ...res, json: res.isError ? undefined : (JSON.parse(res.content) as Record<string, unknown>) };
    };
    return { registry, channels, call, places, roles, made, accessed, reacted, bound, pruned };
  }

  it("lists threads with the gone ones marked, prunes only those with the owner's yes, and shows a project only its own", async () => {
    const root = await harness();
    const listed = (await root.call("discord.threads")).json!;
    expect(listed).toMatchObject({ gone: 2 });
    expect((listed["threads"] as { id: string }[]).map((t) => t.id)).toEqual(["t1", "t2", "t3", "t4"]);
    expect(root.registry.classify("discord.prune", {}).tier).toBe("risky");
    expect((await root.call("discord.prune", { channel: "my-garden" })).json).toMatchObject({ deleted: ["t2"] });
    expect(root.pruned).toEqual(["t2"]);
    expect((await root.call("discord.prune", { channel: "nowhere" })).isError).toBe(true);
    // From a project's chat: its own channel and threads and nothing of another project's, as chats.list has it.
    const garden = await harness(true, "garden");
    expect(((await garden.call("discord.channels")).json!["channels"] as { key: string }[]).map((c) => c.key)).toEqual(["project:garden"]);
    expect(((await garden.call("discord.threads")).json!["threads"] as { id: string }[]).map((t) => t.id)).toEqual(["t1", "t2"]);
    expect((await garden.call("discord.prune")).json).toMatchObject({ deleted: ["t2"] });
    expect(garden.pruned).toEqual(["t2"]);
    expect((await garden.call("discord.audience", { channel: "recap", audience: "owner" })).isError).toBe(true);
    // Maintenance repairs KOS, so it sees the server as the root does.
    const maintenance = await harness(true, "maintenance");
    expect(((await maintenance.call("discord.channels")).json!["channels"] as { key: string }[]).map((c) => c.key)).toEqual(["orchestrator:owner", "needs-you", "project:garden", "agent:recap"]);
    expect(((await maintenance.call("discord.threads")).json!["threads"] as { id: string }[]).map((t) => t.id)).toEqual(["t1", "t2", "t3", "t4"]);
    expect((await maintenance.call("discord.prune")).json).toMatchObject({ deleted: ["t2", "t4"] });
  });

  it("opens a channel to guests only with the owner's yes, reacts, and reads reactions and messages", async () => {
    const h = await harness();
    expect(h.registry.classify("discord.audience", { channel: "garden", audience: "guests" }).tier).toBe("risky");
    const opened = (await h.call("discord.audience", { channel: "#my-garden", audience: "guests" })).json!;
    expect(opened).toMatchObject({ key: "project:garden", audience: "guests" });
    expect(String(opened["note"])).toContain("takes guests");
    expect((await h.call("discord.react", { channel: "picks", message: "m1", emoji: "🎉" })).json).toEqual({ reacted: "🎉", message: "m1" });
    expect(h.reacted).toEqual([["picks", "m1", "🎉"]]);
    expect((await h.call("discord.reactions", { channel: "picks", message: "m1" })).json).toEqual({ reactions: [{ emoji: "👍", count: 2, users: [{ id: "u1", name: "Ana" }, { id: "u2", name: "Bo" }] }] });
    expect((await h.call("discord.messages", { channel: "picks", limit: 1 })).json).toMatchObject({ messages: [{ id: "m1", text: "done" }] });
    expect((await h.call("discord.react", { channel: "picks", message: "m1" })).isError).toBe(true);
    // A member by id, the digits or the mention; never by name.
    expect((await h.call("discord.member", { id: "<@306>" })).json).toMatchObject({ id: "306", name: "splattertron", roles: ["Members"] });
    expect((await h.call("discord.member", { id: "splattertron" })).isError).toBe(true);
    expect(h.registry.classify("discord.member", { id: "306" }).tier).toBe("safe");
  });

  it("reads and reacts only where the chat asking reaches: a guest's work its room alone", async () => {
    const react = async (h: Awaited<ReturnType<typeof harness>>, channel: string): Promise<boolean> => !(await h.call("discord.react", { channel, message: "m1", emoji: "👍" })).isError;
    const reads = async (h: Awaited<ReturnType<typeof harness>>, channel: string): Promise<boolean> =>
      !(await h.call("discord.messages", { channel })).isError && !(await h.call("discord.reactions", { channel, message: "m1" })).isError;

    // A guest in the garden's channel, on the first hop or handed on to Maintenance: that channel and its threads.
    for (const scope of ["garden", "maintenance", undefined]) {
      const h = await harness(true, scope);
      const room = { project: "garden", chat: "project:garden" };
      await guested.run(room, async () => {
        for (const ok of ["my-garden", "#my-garden", "ch3", "t1"]) expect(await react(h, ok), `${scope}: ${ok}`).toBe(true);
        for (const ok of ["my-garden", "t1"]) expect(await reads(h, ok), `${scope}: ${ok}`).toBe(true);
        for (const no of ["kos", "needs-you", "recap", "general", "diary", "c7", "t3", "t4", "999"]) {
          expect(await react(h, no), `${scope}: ${no}`).toBe(false);
          expect(await reads(h, no), `${scope}: ${no}`).toBe(false);
        }
        const refused = await h.call("discord.messages", { channel: "kos" });
        expect(refused.content).toMatch(/a guest's work reads and reacts only there/);
      });
      // Named by Discord's id, so the adapter cannot find a different channel by the same words.
      expect(h.reacted.map(([channel]) => channel)).toEqual(["id:ch3", "id:ch3", "id:ch3", "id:t1"]);
    }

    // A guest in a thread's chat reaches that thread, not the channel above it.
    const thread = await harness(true, "garden");
    await guested.run({ project: "garden", chat: "c1" }, async () => {
      expect(await react(thread, "t1")).toBe(true);
      expect(await react(thread, "my-garden")).toBe(false);
    });

    // A project's chat: its own channel and threads, as the listings show it.
    const garden = await harness(true, "garden");
    for (const ok of ["my-garden", "t1"]) expect(await reads(garden, ok), ok).toBe(true);
    for (const no of ["general", "kos", "t3", "999"]) expect(await reads(garden, no), no).toBe(false);
    // A channel bound to a chat of the project is the project's: from its schedule's run, the chat itself, or another of its chats.
    for (const caller of ["cron:21", "chat-board", "chat-other"]) {
      const h = await harness(true, "garden", caller);
      expect(await reads(h, "board"), caller).toBe(true);
      expect(await react(h, "#board"), caller).toBe(true);
      expect(h.reacted).toEqual([["id:c8", "m1", "👍"]]);
    }
    expect(await reads(await harness(true, "pantry", "chat-pantry"), "board")).toBe(false);
    // Not the room a guest spoke in, so not theirs.
    const room = await harness(true, "garden");
    await guested.run({ project: "garden", chat: "project:garden" }, async () => expect(await reads(room, "board")).toBe(false));
    // A place's own room reads where the place is bound, and nowhere its chat id alone would reach.
    const boardRoom = await harness(true, "garden", "discord:room:c8");
    await guested.run({ project: "garden", chat: "discord:room:c8", home: "chat-board" }, async () => {
      expect(await reads(boardRoom, "board")).toBe(true);
      expect(await reads(boardRoom, "my-garden")).toBe(false);
    });

    // The root and Maintenance reach any channel, by the name they gave.
    for (const scope of [undefined, "maintenance"]) {
      const all = await harness(true, scope);
      expect(await react(all, "general")).toBe(true);
      expect(await reads(all, "999")).toBe(true);
      expect(all.reacted).toEqual([["general", "m1", "👍"]]);
    }
  });

  it("makes a channel of the owner's a chat's home, asking only when others can see it, and only for a project or a blob", async () => {
    const h = await harness();
    // Seen by everyone, or not seen by KOS yet: an ask, and the card says why. The owner's alone: none.
    expect(h.registry.classify("discord.bind", { channel: "#general", to: "project:leetcode_daily" })).toMatchObject({ tier: "risky", reason: "other people can see #general, and the chat would show there" });
    expect(String(h.registry.classify("discord.bind", { channel: "#leetcode", to: "project:leetcode_daily" }).reason)).toContain("not looked at yet");
    expect(h.registry.classify("discord.bind", { channel: "diary", to: "project:leetcode_daily" }).tier).toBe("safe");
    // A channel is found by its id, the one thing about it that does not change.
    expect(findChannel(h.channels, "ch3")?.key).toBe("project:garden");
    // A chat by its id too, written as a reference or bare.
    expect((await h.call("discord.bind", { channel: "#leetcode", to: "@chat:[cmv1:owner]" })).json).toMatchObject({ key: "cmv1:owner" });
    expect(h.bound.at(-1)).toEqual(["#leetcode", "cmv1:owner"]);
    expect((await h.call("discord.bind", { channel: "#leetcode", to: "not a chat id!" })).isError).toBe(true);
    const res = (await h.call("discord.bind", { channel: "#leetcode", to: "project:leetcode_daily" })).json!;
    expect(res).toMatchObject({ key: "project:leetcode_daily", name: "leetcode", audience: "guests" });
    expect(String(res["note"])).toContain("members read and write there, and are heard");
    expect(h.bound.at(-1)).toEqual(["#leetcode", "project:leetcode_daily"]);
    // Whether an id names a chat that exists is the host's check; the tool refuses only what cannot be an id.
    expect((await h.call("discord.bind", { channel: "#leetcode", to: "no such thing" })).isError).toBe(true);
  });

  it("makes places and roles for a purpose of the owner's, and asks only when someone else is let in", async () => {
    const h = await harness();
    expect((await h.call("discord.server")).json).toEqual({ places: h.places, roles: h.roles });
    // A category of the owner's alone: no ask. A channel under it for a role: an ask, since the role's holders will read it.
    expect(h.registry.classify("discord.make", { name: "Book club", kind: "category" }).tier).toBe("safe");
    expect(h.registry.classify("discord.make", { name: "picks", kind: "channel", category: "Book club", access: [{ who: "Members" }] }).tier).toBe("risky");
    expect(h.registry.classify("discord.make", { name: "picks", kind: "channel", access: [{ who: "owner", write: true }] }).tier).toBe("safe");
    const category = (await h.call("discord.make", { name: "Book club", kind: "category" })).json!;
    expect(category).toMatchObject({ id: "p1", name: "Book club", kind: "category" });
    const channel = (await h.call("discord.make", { name: "picks", kind: "channel", category: "Book club", topic: "This month's picks", access: [{ who: "Members", view: true, write: true }] })).json!;
    expect(channel).toMatchObject({ id: "p2", name: "picks", kind: "channel", category: "Book club" });
    expect(String(channel["note"])).toContain("to: discord:channel:p2");
    expect(h.made[1]).toEqual({ name: "picks", kind: "channel", category: "Book club", topic: "This month's picks", access: [{ who: "Members", view: true, write: true }] });
    expect((await h.call("discord.make", { name: "x", kind: "voice" })).isError).toBe(true);
    // A role asks nothing: it holds nobody until access hands it out, and that asks.
    expect(h.registry.classify("discord.role", { name: "Readers" }).tier).toBe("safe");
    expect((await h.call("discord.role", { name: "Readers", colour: "#3B82F6" })).json).toMatchObject({ id: "r2", name: "Readers", colour: "#3b82f6" });
    // Access: letting anyone in asks; shutting a place back to the owner does not.
    expect(h.registry.classify("discord.access", { place: "picks", access: [{ who: "everyone" }] }).tier).toBe("risky");
    expect(h.registry.classify("discord.access", { place: "picks", access: [] }).tier).toBe("safe");
    expect(h.registry.classify("discord.access", { place: "picks", access: [{ who: "Readers", view: false, write: false }] }).tier).toBe("safe");
    expect((await h.call("discord.access", { place: "picks", access: [{ who: "Readers", write: true }] })).json).toMatchObject({ name: "picks", access: [{ who: "Readers", view: true, write: true }] });
    expect(h.accessed).toEqual([["picks", [{ who: "Readers", view: true, write: true }]]]);
    expect((await h.call("discord.access", { place: "nowhere" })).isError).toBe(true);
    expect((await h.call("discord.access", { place: "picks", access: [{ view: true }] })).content).toContain("names who");
  });

  it("lists the channels with who may see each, and finds one any way the owner names it", async () => {
    const h = await harness();
    expect((await h.call("discord.channels")).json).toEqual({ channels: h.channels });
    expect(findChannel(h.channels, "#my-garden")?.key).toBe("project:garden");
    expect(findChannel(h.channels, "project:garden")?.name).toBe("my-garden");
    expect(findChannel(h.channels, "Recap")?.key).toBe("agent:recap");
    expect(findChannel(h.channels, "nothing")).toBeUndefined();
  });

  it("sets when a channel's members reach its chat, without asking, within the caller's reach", async () => {
    const h = await harness(true, "garden");
    expect(h.registry.classify("discord.listen", { channel: "my-garden", when: "mention" }).tier).toBe("safe");
    const gated = (await h.call("discord.listen", { channel: "#my-garden", when: "mention" })).json!;
    expect(gated).toMatchObject({ key: "project:garden", listen: "mention" });
    expect(String(gated["note"])).toContain("only when KOS is @mentioned");
    expect((await h.call("discord.listen", { channel: "ch3", when: "always" })).json).not.toHaveProperty("listen");
    expect((await h.call("discord.listen", { channel: "recap", when: "mention" })).isError).toBe(true);
    expect((await h.call("discord.listen", { channel: "my-garden", when: "sometimes" })).isError).toBe(true);
  });

  it("opens a channel to everyone only with the owner's yes, closes one without, and never KOS's own", async () => {
    const h = await harness();
    expect(h.registry.classify("discord.audience", { channel: "garden", audience: "everyone" }).tier).toBe("risky");
    expect(h.registry.classify("discord.audience", { channel: "garden", audience: "owner" }).tier).toBe("safe");
    const opened = (await h.call("discord.audience", { channel: "#my-garden", audience: "everyone" })).json!;
    expect(opened).toMatchObject({ key: "project:garden", audience: "everyone" });
    expect(h.channels[2]?.audience).toBe("everyone");
    expect((await h.call("discord.audience", { channel: "project:garden", audience: "owner" })).json).toMatchObject({ audience: "owner" });
    expect((await h.call("discord.audience", { channel: "needs-you", audience: "everyone" })).content).toMatch(/owner's alone, always/);
    expect((await h.call("discord.audience", { channel: "kos", audience: "everyone" })).content).toMatch(/owner's alone, always/);
    expect((await h.call("discord.audience", { channel: "nope", audience: "owner" })).content).toMatch(/no channel of KOS's/);
    expect((await h.call("discord.audience", { channel: "recap", audience: "friends" })).content).toMatch(/audience must be/);
  });

  it("lays the server out on request, and says so when there is no server", async () => {
    const h = await harness();
    expect((await h.call("discord.sync")).json).toMatchObject({ created: ["verity"], threads: 2, note: "Made #verity. 2 threads made for chats." });
    expect((await h.call("discord.sync")).json).toMatchObject({ created: [], note: "Every channel and thread was already there." });
    expect(h.registry.classify("discord.sync", {}).tier).toBe("safe");
    const down = await harness(false);
    for (const name of ["discord.channels", "discord.sync"]) expect((await down.call(name)).content).toMatch(/not set up here/);
  });
});
