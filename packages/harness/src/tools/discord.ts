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

export const DISCORD_TOOLS = ["discord.channels", "discord.audience", "discord.sync", "discord.server", "discord.make", "discord.role", "discord.access"] as const;

/** Who may see a channel: the owner alone, or everyone on the server. */
export type Audience = "owner" | "everyone";

export interface ServerChannel {
  /** The conversation the channel is bound to, or "needs-you". */
  key: string;
  name: string;
  /** The category it sits under: KOS, Blobs, or the project's own. */
  category?: string;
  audience: Audience;
  /** Only the owner may ever see KOS's own channel and the approvals. */
  fixed?: boolean;
  /** How many of its chats have a thread under it. */
  threads?: number;
}

/** A role on the server, as KOS may hand it out. */
export interface ServerRole {
  id: string;
  name: string;
  colour?: string;
  members: number;
}

/** Somewhere on the server, KOS's or not: a category, or a text channel under one. */
export interface ServerPlace {
  id: string;
  name: string;
  kind: "category" | "channel";
  category?: string;
  /** What KOS bound it to, when it is one of KOS's own. */
  bound?: string;
  topic?: string;
}

/**
 * Who may see and write somewhere: a role by name, "everyone", or a member
 * by id. The owner and KOS always may; everyone else is out unless named.
 */
export interface Access {
  who: string;
  view: boolean;
  write: boolean;
}

export interface MakePlace {
  name: string;
  kind: "category" | "channel";
  /** For a channel: the category it goes under, by name; none for a category. */
  category?: string;
  topic?: string;
  access?: Access[];
}

export interface DiscordServices {
  /** True while the server surface is up; the tools say so plainly when it is not. */
  connected: () => boolean;
  channels: () => Promise<ServerChannel[]>;
  setAudience: (key: string, audience: Audience) => Promise<ServerChannel>;
  sync: () => Promise<{ created: string[]; kept: string[]; threads: number }>;
  /** Everything on the server: every category and channel, and the roles. */
  server: () => Promise<{ places: ServerPlace[]; roles: ServerRole[] }>;
  /** A category or a channel of KOS's own making, for the owner's purpose. */
  make: (input: MakePlace) => Promise<ServerPlace>;
  createRole: (name: string, colour?: string) => Promise<ServerRole>;
  /** Who may see and write in a channel or category, replacing what was set. */
  setAccess: (place: string, access: Access[]) => Promise<ServerPlace>;
}

/** Access entries as the tool takes them, checked. */
export function parseAccess(raw: unknown): Access[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("access must be a list of { who, view, write }");
  return raw.map((entry) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    if (typeof e["who"] !== "string" || !e["who"].trim()) throw new Error("each access entry names who: a role, everyone, or a member id");
    return { who: e["who"].trim(), view: e["view"] !== false, write: e["write"] === true };
  });
}

/** True when an entry lets someone other than the owner in: what asks the owner first. */
export function opensUp(access: Access[]): boolean {
  return access.some((a) => a.who.toLowerCase() !== "owner" && (a.view || a.write));
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
        "The channels KOS keeps on the owner's Discord server, laid out as the dashboard is: #kos and #needs-you under the KOS category, a channel per blob under Blobs, and a category per project holding its channel (the project's orchestrator) with a thread for each chat in the project. " +
        "Each is listed with what it is bound to, its category, who may see it (owner, the default, or everyone on the server) and how many chats have threads under it.",
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
      description: "Lay the server out now: a category and channel for every project, a channel for every blob, and a thread for every chat that has none yet. Done on its own every few minutes; this is for right away.",
      inputSchema: { type: "object", properties: {} },
    },
    async () => {
      up();
      const made = await deps.sync();
      const said = [
        ...(made.created.length ? [`Made ${made.created.map((c) => `#${c}`).join(", ")}.`] : []),
        ...(made.threads ? [`${made.threads} thread${made.threads === 1 ? "" : "s"} made for chats.`] : []),
      ];
      return JSON.stringify({ ...made, note: said.length ? said.join(" ") : "Every channel and thread was already there." });
    },
    { floor: "safe" },
    { restricted: true },
  );
}

function defineAdminTools(deps: DiscordServices, ctx: ModuleContext): void {
  const up = (): void => {
    if (!deps.connected()) throw new Error("the Discord server is not set up here: KOS_DISCORD_GUILD names it, under Settings, Network.");
  };
  const ACCESS_SCHEMA = {
    type: "array",
    description:
      'who may see and write there, besides the owner and KOS, who always may: [{ who: "Members", view: true, write: false }]. who is a role by name, "everyone" for the whole server, or a member id. Nobody not named gets in.',
    items: {
      type: "object",
      properties: { who: { type: "string" }, view: { type: "boolean", description: "may read it (default true)" }, write: { type: "boolean", description: "may write in it (default false)" } },
      required: ["who"],
    },
  };

  ctx.registerTool(
    {
      name: "discord.server",
      description:
        "Everything on the owner's Discord server: every category and channel (with what KOS bound it to, when it is KOS's), and the roles with how many hold each. Read this before making a place or a role, and to find names for discord.access.",
      inputSchema: { type: "object", properties: {} },
    },
    async () => {
      up();
      return JSON.stringify(await deps.server());
    },
    { floor: "safe" },
    { restricted: true },
  );

  ctx.registerTool(
    {
      name: "discord.make",
      description:
        "Make a category, or a text channel under one, on the owner's server for a purpose of the owner's: a space for a group, a feed, a board for something you built. It is the owner's alone until access says otherwise. " +
        "To set a space up for other people: discord.role for a role they will hold (or use one that exists), discord.make the category and its channels with access for that role, then post into a channel with notify (to: discord:channel:<id>), with buttons or a form where something should be pressed or filled in.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "the channel or category name, as Discord shows it" },
          kind: { type: "string", enum: ["category", "channel"], description: "a category, or a text channel" },
          category: { type: "string", description: "for a channel: the category to put it under, by name; it must exist" },
          topic: { type: "string", description: "for a channel: the line under its name" },
          access: ACCESS_SCHEMA,
        },
        required: ["name", "kind"],
      },
    },
    async (input) => {
      up();
      const kind = input["kind"];
      if (kind !== "category" && kind !== "channel") throw new Error('kind must be "category" or "channel"');
      const category = typeof input["category"] === "string" && input["category"].trim() ? input["category"].trim() : undefined;
      const topic = typeof input["topic"] === "string" && input["topic"].trim() ? input["topic"].trim() : undefined;
      const access = parseAccess(input["access"]);
      const made = await deps.make({ name: str(input, "name"), kind, ...(category ? { category } : {}), ...(topic ? { topic } : {}), ...(access.length ? { access } : {}) });
      return JSON.stringify({ ...made, note: `Made ${made.kind === "category" ? made.name : `#${made.name}`}${access.length ? ` for ${access.map((a) => a.who).join(", ")}` : ", for the owner alone"}. Post into a channel with notify, to: discord:channel:${made.id}.` });
    },
    // Letting other people into the new place is what asks; a place of the owner's alone does not.
    { floor: "safe", escalate: (input) => opensUp(parseAccess(input["access"])) },
    { restricted: true },
  );

  ctx.registerTool(
    {
      name: "discord.role",
      description: "Make a role on the owner's server, to hand out and to name in discord.access. The owner gives it to people themselves, in Discord. Asks the owner first.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" }, colour: { type: "string", description: "#rrggbb, when a colour is wanted" } },
        required: ["name"],
      },
    },
    async (input) => {
      up();
      const colour = typeof input["colour"] === "string" && /^#[0-9a-f]{6}$/i.test(input["colour"].trim()) ? input["colour"].trim().toLowerCase() : undefined;
      const made = await deps.createRole(str(input, "name"), colour);
      return JSON.stringify({ ...made, note: `Made the role ${made.name}. The owner hands it out in Discord; name it in discord.access to let its holders somewhere.` });
    },
    // A role is a thing other people will hold.
    { floor: "safe", escalate: () => true },
    { restricted: true },
  );

  ctx.registerTool(
    {
      name: "discord.access",
      description:
        "Set who may see and write in a channel or category on the server, replacing what was set: the owner and KOS always may; everyone else only as named. Letting anyone in asks the owner first; shutting a place back to the owner alone (an empty access) does not. For one of KOS's own chat channels, discord.audience is the simpler form.",
      inputSchema: {
        type: "object",
        properties: { place: { type: "string", description: "the channel or category, by name or id, as discord.server lists them" }, access: ACCESS_SCHEMA },
        required: ["place"],
      },
    },
    async (input) => {
      up();
      const access = parseAccess(input["access"]);
      const now = await deps.setAccess(str(input, "place"), access);
      return JSON.stringify({ ...now, access, note: access.length ? `${now.name} is open to ${access.map((a) => `${a.who} (${a.write ? "read and write" : "read"})`).join(", ")}.` : `${now.name} is the owner's alone.` });
    },
    { floor: "safe", escalate: (input) => opensUp(parseAccess(input["access"])) },
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
      defineAdminTools(deps, ctx);
    },
  };
}
