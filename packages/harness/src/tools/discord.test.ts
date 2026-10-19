import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { ModuleLoader, toolRegistryContext } from "../modules/loader.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Workspace } from "../store/workspace.js";
import { createDiscordModule, findChannel, type ServerChannel } from "./discord.js";

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
          return { created: synced.length === 1 ? ["verity"] : [], kept: ["kos"] };
        },
      }),
    ]);
    const call = async (name: string, input: Record<string, unknown> = {}) => {
      const res = await registry.execute(name, input);
      return { ...res, json: res.isError ? undefined : (JSON.parse(res.content) as Record<string, unknown>) };
    };
    return { registry, channels, call };
  }

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
    expect((await h.call("discord.sync")).json).toMatchObject({ created: ["verity"], note: "Made #verity." });
    expect((await h.call("discord.sync")).json).toMatchObject({ created: [], note: "Every channel was already there." });
    expect(h.registry.classify("discord.sync", {}).tier).toBe("safe");
    const down = await harness(false);
    for (const name of ["discord.channels", "discord.sync"]) expect((await down.call(name)).content).toMatch(/not set up here/);
  });
});
