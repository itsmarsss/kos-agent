import type { EmbedBuilder, Interaction } from "discord.js";
import { MessageFlags } from "discord.js";
import { describe, expect, it } from "vitest";

import { DiscordAdapter } from "./discord.js";
import { splitBlocks } from "./discordblocks.js";
import { OWNER_ONLY, type InboundMessage } from "./types.js";

const EMAIL = ["Here is the draft:", "", "```kos:email", "to: sam@example.com", "subject: Saturday at 4", "---", "Hi Sam,", "", "Still on?", "```", "", "Want me to send it?"].join("\n");

interface Sent {
  content?: string;
  embeds?: EmbedBuilder[];
  components?: { toJSON(): { components: { label?: string; custom_id?: string; url?: string }[] } }[];
}

function adapterWith(tools: string[]): { adapter: DiscordAdapter; sent: Sent[] } {
  const adapter = new DiscordAdapter({ token: "t", toolNames: () => tools });
  const sent: Sent[] = [];
  (adapter as unknown as { client: unknown }).client = { users: { fetch: async () => ({ send: async (p: Sent) => (sent.push(p), { id: "m1" }) }) } };
  return { adapter, sent };
}

const buttonsOf = (s: Sent): { label?: string; custom_id?: string; url?: string }[] => (s.components ?? []).flatMap((r) => r.toJSON().components);

function press(customId: string, userId: string, replies: unknown[]): Interaction {
  return {
    isButton: () => true,
    customId,
    user: { id: userId },
    guildId: null,
    channel: { id: "dm" },
    message: { id: "m1", channel: { id: "dm", send: async () => ({ id: "s", edit: async () => undefined, delete: async () => undefined }) }, guild: null },
    reply: async (p: unknown) => void replies.push(p),
  } as unknown as Interaction;
}

describe("a typed block on Discord", () => {
  it("is an embed with its fields and body, under the words around it, with Copy and Send", async () => {
    const { adapter, sent } = adapterWith(["gmail.send", "notify"]);
    await adapter.send("owner", { text: EMAIL });
    expect(sent[0]?.content).toBe("Here is the draft:\n\nWant me to send it?");
    const embed = sent[0]!.embeds![0]!.toJSON();
    expect(embed.title).toBe("Email");
    expect(embed.fields).toEqual([
      { name: "To", value: "sam@example.com", inline: true },
      { name: "Subject", value: "Saturday at 4", inline: true },
    ]);
    expect(embed.description).toBe("Hi Sam,\n\nStill on?");
    expect(buttonsOf(sent[0]!).map((b) => b.label)).toEqual(["Copy", "Send"]);
  });

  it("offers no Send where nothing here can send it", async () => {
    const { adapter, sent } = adapterWith([]);
    await adapter.send("owner", { text: EMAIL });
    expect(buttonsOf(sent[0]!).map((b) => b.label)).toEqual(["Copy"]);
  });

  it("keeps the owner's own words as written", async () => {
    const { adapter, sent } = adapterWith(["gmail.send"]);
    const owner = { name: "Kenny", avatarUrl: "https://cdn/x.png" };
    (adapter as unknown as { owner: unknown }).owner = owner;
    await adapter.send("owner", { text: EMAIL, from: owner });
    expect(sent[0]?.embeds ?? []).toEqual([]);
    expect(sent[0]?.content).toContain("Draft email");
  });

  it("draws five blocks a message, the rest in words", () => {
    const one = "```kos:command\n---\nls\n```";
    const { words, blocks } = splitBlocks(Array.from({ length: 6 }, () => one).join("\n\n"));
    expect(blocks).toHaveLength(5);
    expect(words).toBe("Command\n\nls");
  });

  it("copies the draft to the presser alone, as a code block", async () => {
    const { adapter, sent } = adapterWith(["gmail.send"]);
    adapter.setAuthorizer((id) => id === "owner");
    await adapter.send("owner", { text: EMAIL });
    const copy = buttonsOf(sent[0]!).find((b) => b.label === "Copy")!.custom_id!;
    const replies: { content: string; flags: number }[] = [];
    await adapter.receiveInteraction(press(copy, "owner", replies));
    expect(replies[0]).toEqual({ content: "```\nHi Sam,\n\nStill on?\n```", flags: MessageFlags.Ephemeral });
  });

  it("sends through a turn of the chat, where the tool call asks as any other", async () => {
    const { adapter, sent } = adapterWith(["gmail.send"]);
    adapter.setAuthorizer((id) => id === "owner");
    const heard: InboundMessage[] = [];
    adapter.onMessage((m) => void heard.push(m));
    await adapter.send("owner", { text: EMAIL });
    const send = buttonsOf(sent[0]!).find((b) => b.label === "Send")!.custom_id!;
    const replies: unknown[] = [];
    await adapter.receiveInteraction(press(send, "owner", replies));
    expect(heard).toHaveLength(1);
    expect(heard[0]?.senderId).toBe("owner");
    expect(heard[0]?.text).toMatch(/^Send this email as drafted, with gmail\.send\./);
    expect(heard[0]?.text).toContain("to: sam@example.com");
  });

  it("refuses a guest's press and runs nothing", async () => {
    const { adapter, sent } = adapterWith(["gmail.send"]);
    adapter.setAuthorizer((id) => id === "owner");
    const heard: InboundMessage[] = [];
    adapter.onMessage((m) => void heard.push(m));
    await adapter.send("owner", { text: EMAIL });
    const replies: { content: string }[] = [];
    for (const b of buttonsOf(sent[0]!)) await adapter.receiveInteraction(press(b.custom_id!, "ana", replies));
    expect(replies.map((r) => r.content)).toEqual([OWNER_ONLY, OWNER_ONLY]);
    expect(heard).toEqual([]);
  });
});
