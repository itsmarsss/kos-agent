import type { KosModule, ModuleContext } from "../modules/loader.js";

/**
 * The `discord` tool module: KOS's own server, run by KOS.
 *
 * The server is laid out by the host (a channel per project and per blob),
 * but who may see a channel is the owner's call and a thing they say in a
 * chat: "open the workout channel up", "that one is mine only". These are
 * the primitives for that, so KOS does it rather than the owner finding a
 * settings page. Everything is for the owner's eyes alone until they say
 * otherwise, one channel at a time.
 */

export const DISCORD_TOOLS = ["discord.channels", "discord.audience", "discord.sync"] as const;

/** Who may see a channel: the owner alone, or everyone on the server. */
export type Audience = "owner" | "everyone";

export interface ServerChannel {
  /** The conversation the channel is bound to, or "needs-you". */
  key: string;
  name: string;
  audience: Audience;
  /** Only the owner may ever see KOS's own channel and the approvals. */
  fixed?: boolean;
}

export interface DiscordServices {
  /** True while the server surface is up; the tools say so plainly when it is not. */
  connected: () => boolean;
  channels: () => Promise<ServerChannel[]>;
  setAudience: (key: string, audience: Audience) => Promise<ServerChannel>;
  sync: () => Promise<{ created: string[]; kept: string[] }>;
}

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || v.trim() === "") throw new Error(`missing arg: ${key}`);
  return v.trim();
}

/** A channel named any way the owner would: by name, with or without #, or by what it is bound to. */
export function findChannel(channels: ServerChannel[], named: string): ServerChannel | undefined {
  const want = named.trim().replace(/^#/, "").toLowerCase();
  return channels.find((c) => c.name.toLowerCase() === want || c.key.toLowerCase() === want || c.key.toLowerCase().endsWith(`:${want}`));
}

function defineDiscordTools(deps: DiscordServices, ctx: ModuleContext): void {
  const up = (): void => {
    if (!deps.connected()) throw new Error("the Discord server is not set up here: KOS_DISCORD_GUILD names it, under Settings, Network.");
  };

  ctx.registerTool(
    {
      name: "discord.channels",
      description:
        "The channels KOS keeps on the owner's Discord server, with what each is bound to (a project, a blob, KOS itself, the approvals) and who may see it: owner (the default; only the owner and KOS) or everyone on the server.",
      inputSchema: { type: "object", properties: {} },
    },
    async () => {
      up();
      return JSON.stringify({ channels: await deps.channels() });
    },
    { floor: "safe" },
    { restricted: true },
  );

  ctx.registerTool(
    {
      name: "discord.audience",
      description:
        "Who may see one of KOS's channels on the server: owner (only the owner and KOS) or everyone on it. Opening a channel to everyone shows them what is said there from then on, so it asks the owner first; closing one does not. KOS's own channel and the approvals stay the owner's.",
      inputSchema: {
        type: "object",
        properties: {
          channel: { type: "string", description: "the channel's name, or what it is bound to (project:<slug>, agent:<name>)" },
          audience: { type: "string", enum: ["owner", "everyone"] },
        },
        required: ["channel", "audience"],
      },
    },
    async (input) => {
      up();
      const audience = input["audience"];
      if (audience !== "owner" && audience !== "everyone") throw new Error('audience must be "owner" or "everyone"');
      const found = findChannel(await deps.channels(), str(input, "channel"));
      if (!found) throw new Error(`no channel of KOS's called ${str(input, "channel")}; discord.channels lists them`);
      if (found.fixed) throw new Error(`${found.name} is the owner's alone, always`);
      const now = await deps.setAudience(found.key, audience);
      return JSON.stringify({ ...now, note: audience === "everyone" ? `#${now.name} is open to everyone on the server now.` : `#${now.name} is the owner's alone now.` });
    },
    // Opening a channel shows other people the owner's chat; closing one shows nobody anything.
    { floor: "safe", escalate: (input) => input["audience"] === "everyone" },
    { restricted: true },
  );

  ctx.registerTool(
    {
      name: "discord.sync",
      description: "Lay the server out now: a channel for every project and blob that has none yet. Done on its own every few minutes; this is for right away.",
      inputSchema: { type: "object", properties: {} },
    },
    async () => {
      up();
      const made = await deps.sync();
      return JSON.stringify({ ...made, note: made.created.length ? `Made ${made.created.map((c) => `#${c}`).join(", ")}.` : "Every channel was already there." });
    },
    { floor: "safe" },
    { restricted: true },
  );
}

export function createDiscordModule(deps: DiscordServices): KosModule {
  return {
    manifest: {
      name: "discord",
      version: "1.0.0",
      provides: DISCORD_TOOLS.map((name) => ({ kind: "tool" as const, name, version: "1.0.0" })),
      riskTier: "safe",
    },
    activate(ctx) {
      defineDiscordTools(deps, ctx);
    },
  };
}
