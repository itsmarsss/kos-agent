import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { ModuleLoader, toolRegistryContext } from "../modules/loader.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Workspace } from "../store/workspace.js";
import { createDiscordModule, findChannel, type Access, type MakePlace, type ServerChannel, type ServerPlace, type ServerRole } from "./discord.js";

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

  async function harness(connected = true) {
    const channels: ServerChannel[] = [
      { key: "orchestrator:owner", name: "kos", audience: "owner", fixed: true },
      { key: "needs-you", name: "needs-you", audience: "owner", fixed: true },
      { key: "project:garden", name: "my-garden", audience: "owner" },
      { key: "agent:recap", name: "recap", audience: "owner" },
    ];
    const synced: number[] = [];
    const places: ServerPlace[] = [{ id: "c0", name: "general", kind: "channel" }];
    const roles: ServerRole[] = [{ id: "r0", name: "Members", members: 3 }];
    const made: MakePlace[] = [];
    const accessed: [string, Access[]][] = [];
    const registry = new ToolRegistry();
    const ctx = toolRegistryContext(registry, { workspace: ws, db: ws.db, secrets: new SecretsRegistry() });
    await new ModuleLoader(ctx).load([
      createDiscordModule({
        connected: () => connected,
        channels: async () => channels,
        setAudience: async (key, audience) => {
          const c = channels.find((x) => x.key === key)!;
          c.audience = audience;
          return c;
        },
        sync: async () => {
          synced.push(1);
          return { created: synced.length === 1 ? ["verity"] : [], kept: ["kos"], threads: synced.length === 1 ? 2 : 0 };
        },
        server: async () => ({ places, roles }),
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
      }),
    ]);
    const call = async (name: string, input: Record<string, unknown> = {}) => {
      const res = await registry.execute(name, input);
      return { ...res, json: res.isError ? undefined : (JSON.parse(res.content) as Record<string, unknown>) };
    };
    return { registry, channels, call, places, roles, made, accessed };
  }

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
    // A role always asks; the owner hands it out.
    expect(h.registry.classify("discord.role", { name: "Readers" }).tier).toBe("risky");
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
