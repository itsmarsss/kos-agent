import type { EmbedBuilder, Interaction } from "discord.js";
import { MessageFlags } from "discord.js";
import { describe, expect, it } from "vitest";

import { DiscordAdapter } from "./discord.js";
import type { SlashContext } from "./commands.js";
import { OWNER_ONLY, type ApprovalDecision, type ApprovalRequest } from "./types.js";

interface Said {
  content?: string;
  embeds?: EmbedBuilder[];
  flags?: number;
  files?: { attachment: Buffer; name: string }[];
  components?: { toJSON(): { components: { label?: string; custom_id?: string; url?: string }[] } }[];
}

function slash(commandName: string, value: string | undefined, user = "owner", extra: Record<string, unknown> = {}): { interaction: Interaction; replies: Said[]; edits: Said[]; followUps: Said[]; deferred: unknown[] } {
  const replies: Said[] = [];
  const edits: Said[] = [];
  const followUps: Said[] = [];
  const deferred: unknown[] = [];
  const interaction = {
    isButton: () => false,
    isAutocomplete: () => false,
    isChatInputCommand: () => true,
    commandName,
    user: { id: user },
    guildId: null,
    channel: { id: "dm" },
    options: { data: value === undefined ? [] : [{ value }] },
    reply: async (p: Said) => void replies.push(p),
    deferReply: async (p: unknown) => void deferred.push(p),
    editReply: async (p: Said) => void edits.push(p),
    followUp: async (p: Said) => void followUps.push(p),
    ...extra,
  } as unknown as Interaction;
  return { interaction, replies, edits, followUps, deferred };
}

function adapterWith(ctx: Partial<SlashContext> = {}, options: { dashboardUrl?: string; scrub?: (text: string) => string } = {}): { adapter: DiscordAdapter; ran: { text: string; id: string }[] } {
  const adapter = new DiscordAdapter({ token: "t", guildId: "g1", ...options });
  adapter.setAuthorizer((id) => id === "owner");
  const ran: { text: string; id: string }[] = [];
  adapter.onCommand({
    list: () => [],
    current: () => "dm-chat",
    home: () => "discord:owner",
    run: async (text, id) => (ran.push({ text, id }), { reply: `ran ${text}` }),
    ...ctx,
  });
  return { adapter, ran };
}

describe("a slash command from the shared registry", () => {
  it("runs through the kernel in the DM's chat and answers the presser alone", async () => {
    const { adapter, ran } = adapterWith();
    const s = slash("mode", "auto");
    await adapter.receiveInteraction(s.interaction);
    expect(ran).toEqual([{ text: "/mode auto", id: "dm-chat" }]);
    expect(s.deferred).toEqual([{ flags: MessageFlags.Ephemeral }]);
    const card = s.edits[0]!.embeds![0]!.toJSON();
    expect(card.title).toBe("/mode");
    expect(card.description).toBe("ran /mode auto");
  });

  it("runs in the chat a room is bound to when typed there", async () => {
    const { adapter, ran } = adapterWith();
    const s = slash("compact", undefined, "owner", { guildId: "g1", channel: { id: "c1", topic: "kos:project:garden · Garden" } });
    await adapter.receiveInteraction(s.interaction);
    expect(ran).toEqual([{ text: "/compact", id: "project:garden" }]);
  });

  it("refuses a guest, running nothing", async () => {
    const { adapter, ran } = adapterWith();
    for (const name of ["mode", "halt", "inbox", "approve"]) {
      const s = slash(name, undefined, "ana");
      await adapter.receiveInteraction(s.interaction);
      expect(s.replies, name).toEqual([{ content: OWNER_ONLY, flags: MessageFlags.Ephemeral }]);
    }
    expect(ran).toEqual([]);
  });

  it("says what went wrong when the command throws", async () => {
    const { adapter } = adapterWith({ run: async () => Promise.reject(new Error("the store is closed")) });
    const s = slash("status", undefined);
    await adapter.receiveInteraction(s.interaction);
    expect(s.edits[0]!.embeds![0]!.toJSON().description).toBe("/status did not run: the store is closed");
  });
});

describe("/inbox on Discord", () => {
  const asks: ApprovalRequest[] = [
    { id: "12", text: "x", tool: "shell.run", args: { command: "rm -rf build" } },
    { id: "13", text: "x", tool: "secrets.fill", args: { handle: "github" } },
  ];

  it("posts each ask as a card of its own with its buttons, a secret's with no Approve, to the presser alone", async () => {
    const { adapter } = adapterWith({ pending: () => asks }, { dashboardUrl: "https://kos.example.com" });
    const s = slash("inbox", undefined);
    await adapter.receiveInteraction(s.interaction);
    expect(s.replies[0]).toEqual({ content: "2 waiting on you.", flags: MessageFlags.Ephemeral });
    expect(s.followUps).toHaveLength(2);
    expect(s.followUps.every((f) => f.flags === MessageFlags.Ephemeral)).toBe(true);
    expect(s.followUps[0]!.content).toContain("rm -rf build");
    const labels = s.followUps.map((f) => f.components![0]!.toJSON().components.map((b) => b.label));
    expect(labels).toEqual([["Approve", "Deny"], ["Decide on the dashboard", "Deny"]]);
  });

  it("decides an ask from its card's button through the one approval path", async () => {
    const { adapter } = adapterWith({ pending: () => asks });
    const decided: ApprovalDecision[] = [];
    adapter.onApproval((d) => (decided.push(d), { outcome: "approved" }));
    const s = slash("inbox", undefined);
    await adapter.receiveInteraction(s.interaction);
    const approve = s.followUps[0]!.components![0]!.toJSON().components[0]!.custom_id!;
    const edits: Said[] = [];
    await adapter.receiveInteraction({ isButton: () => true, customId: approve, user: { id: "owner", username: "kenny" }, deferUpdate: async () => undefined, editReply: async (p: Said) => void edits.push(p), reply: async () => undefined } as unknown as Interaction);
    expect(decided).toEqual([{ id: "12", approved: true, deciderId: "owner" }]);
    expect(edits[0]!.content).toMatch(/^-# ✅ Approved by kenny <t:\d+:t> · #12$/);
  });

  it("attaches the call, scrubbed, and the page a long ask carries, so Approve is seen whole", async () => {
    const long: ApprovalRequest = { id: "14", text: "x", tool: "shell.run", args: { command: `echo hunter2 ${"y".repeat(3000)}` }, picture: Buffer.from("jpeg").toString("base64") };
    const { adapter } = adapterWith({ pending: () => [long] }, { scrub: (t) => t.replaceAll("hunter2", "[secret]") });
    const s = slash("inbox", undefined);
    await adapter.receiveInteraction(s.interaction);
    const files = s.followUps[0]!.files!;
    expect(files.map((f) => f.name)).toEqual(["page.jpg", "call.json"]);
    expect(files[0]!.attachment.toString()).toBe("jpeg");
    const call = files[1]!.attachment.toString("utf8");
    expect(call).toContain("[secret]");
    expect(call).not.toContain("hunter2");
  });

  it("says when nothing waits", async () => {
    const { adapter } = adapterWith({ pending: () => [] });
    const s = slash("inbox", undefined);
    await adapter.receiveInteraction(s.interaction);
    expect(s.replies[0]?.content).toBe("Nothing is waiting on you.");
    expect(s.followUps).toEqual([]);
  });
});

describe("picking an ask for /approve", () => {
  it("offers each by what it does, with no secret's value in it", async () => {
    const { adapter } = adapterWith({ pending: () => [{ id: "21", text: "x", tool: "shell.run", args: { command: "curl -H 'token: hunter2' api" } }] }, { scrub: (t) => t.replaceAll("hunter2", "[secret]") });
    const offered: { name: string; value: string }[][] = [];
    await adapter.receiveInteraction({
      isAutocomplete: () => true,
      commandName: "approve",
      user: { id: "owner" },
      options: { getFocused: () => "" },
      respond: async (c: { name: string; value: string }[]) => void offered.push(c),
    } as unknown as Interaction);
    expect(offered[0]).toHaveLength(1);
    expect(offered[0]![0]!.value).toBe("21");
    expect(offered[0]![0]!.name).toContain("[secret]");
    expect(offered[0]![0]!.name).not.toContain("hunter2");
  });
});

describe("registering the commands", () => {
  it("registers them for the owner's server, and for DMs alone globally", async () => {
    const { adapter } = adapterWith();
    const sets: { count: number; guild?: string; dmOnly: boolean }[] = [];
    (adapter as unknown as { client: unknown }).client = {
      application: { commands: { set: async (data: { contexts?: number[] }[], guild?: string) => void sets.push({ count: data.length, ...(guild ? { guild } : {}), dmOnly: data.every((d) => d.contexts?.length === 1) }) } },
    };
    await (adapter as unknown as { registerCommands(): Promise<void> }).registerCommands();
    expect(sets).toHaveLength(2);
    expect(sets[0]).toMatchObject({ guild: "g1", dmOnly: false });
    expect(sets[1]).toMatchObject({ dmOnly: true });
    expect(sets[0]!.count).toBe(sets[1]!.count);
    expect(sets[0]!.count).toBeGreaterThan(20);
  });

  it("registers the DM's commands even when the server refuses its own", async () => {
    const { adapter } = adapterWith();
    const sets: (string | undefined)[] = [];
    (adapter as unknown as { client: unknown }).client = {
      application: { commands: { set: async (_: unknown, guild?: string) => (guild ? Promise.reject(new Error("Missing Access")) : void sets.push(guild)) } },
    };
    await (adapter as unknown as { registerCommands(): Promise<void> }).registerCommands();
    expect(sets).toEqual([undefined]);
  });
});
