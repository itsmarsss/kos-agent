import type { Interaction, Message } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import {
  APPROVE_PREFIX,
  DENY_PREFIX,
  DiscordAdapter,
  PRESS_PREFIX,
  approvalCustomIds,
  buildButtons,
  buildCard,
  chunkText,
  parseApprovalCustomId,
} from "./discord.js";
import type { ApprovalDecision, ButtonPress, InboundMessage } from "./types.js";

describe("discord approval customId codec", () => {
  it("encodes approve and deny ids for a pending action", () => {
    expect(approvalCustomIds("p1")).toEqual({
      approve: `${APPROVE_PREFIX}p1`,
      deny: `${DENY_PREFIX}p1`,
    });
  });

  it("round-trips an approve decision", () => {
    const { approve } = approvalCustomIds("abc");
    expect(parseApprovalCustomId(approve)).toEqual({ id: "abc", approved: true });
  });

  it("round-trips a deny decision", () => {
    const { deny } = approvalCustomIds("abc");
    expect(parseApprovalCustomId(deny)).toEqual({ id: "abc", approved: false });
  });

  it("returns null for an unrelated customId", () => {
    expect(parseApprovalCustomId("other:thing")).toBeNull();
  });

  it("preserves ids containing separators", () => {
    const { approve } = approvalCustomIds("a:b:c");
    expect(parseApprovalCustomId(approve)).toEqual({
      id: "a:b:c",
      approved: true,
    });
  });
});

interface FakeInteraction {
  isButton(): boolean;
  customId: string;
  user: { id: string };
  update: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
}

function fakeMessage(authorId: string): Message {
  return {
    author: { id: authorId, bot: false },
    guild: null,
    content: "hi",
  } as unknown as Message;
}

function fakeButton(authorId: string, customId: string): FakeInteraction {
  return {
    isButton: () => true,
    customId,
    user: { id: authorId },
    update: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    component: { label: "Ship it" },
  } as unknown as FakeInteraction;
}

describe("agent-authored cards and buttons", () => {
  it("renders a card with its fields", () => {
    const embed = buildCard({
      title: "Backup",
      body: "done",
      fields: [{ name: "Size", value: "2MB", inline: true }],
    }).toJSON();
    expect(embed.title).toBe("Backup");
    expect(embed.fields).toEqual([{ name: "Size", value: "2MB", inline: true }]);
  });

  it("trims a field rather than refusing the whole message", () => {
    const embed = buildCard({ fields: [{ name: "n", value: "x".repeat(2000) }] }).toJSON();
    expect(embed.fields?.[0]?.value).toHaveLength(1024);
  });

  it("carries the press token as the custom id, and a link instead of one", () => {
    const rows = buildButtons([
      { label: "Ship it", id: "ship", style: "success", token: "tok1" },
      { label: "Docs", url: "https://example.com" },
    ]);
    const json = rows[0]!.toJSON();
    expect(json.components[0]).toMatchObject({
      custom_id: `${PRESS_PREFIX}tok1`,
      label: "Ship it",
    });
    expect(json.components[1]).toMatchObject({ url: "https://example.com" });
  });

  it("wraps past five into a second row", () => {
    const rows = buildButtons(
      Array.from({ length: 7 }, (_, i) => ({ label: `b${i}`, token: `t${i}` })),
    );
    expect(rows).toHaveLength(2);
    expect(rows[1]!.toJSON().components).toHaveLength(2);
  });
});

describe("DiscordAdapter authorization", () => {
  function adapterFor(ownerId: string): {
    adapter: DiscordAdapter;
    messages: InboundMessage[];
    decisions: ApprovalDecision[];
  } {
    const adapter = new DiscordAdapter({ token: "t" });
    const messages: InboundMessage[] = [];
    const decisions: ApprovalDecision[] = [];
    adapter.setAuthorizer((senderId) => senderId === ownerId);
    adapter.onMessage((msg) => {
      messages.push(msg);
    });
    adapter.onApproval((decision) => {
      decisions.push(decision);
    });
    return { adapter, messages, decisions };
  }

  it("passes a DM from the authorized sender to the handler", async () => {
    const { adapter, messages } = adapterFor("owner-id");
    await adapter.receiveMessage(fakeMessage("owner-id"));
    expect(messages).toHaveLength(1);
    expect(messages[0]?.senderId).toBe("owner-id");
  });

  it("drops a DM from an unauthorized sender", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { adapter, messages } = adapterFor("owner-id");
    await adapter.receiveMessage(fakeMessage("stranger"));
    expect(messages).toEqual([]);
    vi.restoreAllMocks();
  });

  it("hands a press on an agent button back with its token", async () => {
    const adapter = new DiscordAdapter({ token: "t" });
    const presses: ButtonPress[] = [];
    adapter.setAuthorizer((senderId) => senderId === "owner-id");
    adapter.onButton((press) => {
      presses.push(press);
    });
    const button = fakeButton("owner-id", `${PRESS_PREFIX}tok9`);
    await adapter.receiveInteraction(button as unknown as Interaction);
    expect(presses).toEqual([
      { buttonId: "", label: "Ship it", token: "tok9", pressedBy: "owner-id" },
    ]);
    // Acknowledged without editing the message: the buttons stay usable,
    // because a press is a message rather than a decision that consumes it.
    expect((button as unknown as { deferUpdate: () => void }).deferUpdate).toHaveBeenCalled();
  });

  it("drops a press from a stranger", async () => {
    const adapter = new DiscordAdapter({ token: "t" });
    const presses: ButtonPress[] = [];
    adapter.setAuthorizer((senderId) => senderId === "owner-id");
    adapter.onButton((press) => {
      presses.push(press);
    });
    await adapter.receiveInteraction(
      fakeButton("stranger", `${PRESS_PREFIX}tok9`) as unknown as Interaction,
    );
    expect(presses).toEqual([]);
  });

  it("passes an approval click from the authorized sender", async () => {
    const { adapter, decisions } = adapterFor("owner-id");
    const button = fakeButton("owner-id", approvalCustomIds("5").approve);
    await adapter.receiveInteraction(button as unknown as Interaction);
    expect(decisions).toEqual([
      { id: "5", approved: true, deciderId: "owner-id" },
    ]);
    expect(button.update).toHaveBeenCalled();
  });

  it("rejects an approval click from an unauthorized sender", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { adapter, decisions } = adapterFor("owner-id");
    const button = fakeButton("stranger", approvalCustomIds("5").approve);
    await adapter.receiveInteraction(button as unknown as Interaction);

    expect(decisions).toEqual([]);
    // the prompt keeps its buttons so the owner can still decide
    expect(button.update).not.toHaveBeenCalled();
    expect(button.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Not authorized." }),
    );
    vi.restoreAllMocks();
  });
});

describe("chunkText", () => {
  it("leaves short text alone", () => {
    expect(chunkText("hi", 10)).toEqual(["hi"]);
  });

  it("splits long text on newlines when possible", () => {
    const chunks = chunkText("aaaa\nbbbb\ncccc", 6);
    expect(chunks.join("").replace(/\n/g, "").length).toBe(12);
    expect(chunks.every((c) => c.length <= 6)).toBe(true);
  });
});

describe("chunkText formatting safety", () => {
  it("keeps a short reply as a single chunk", () => {
    expect(chunkText("just a line")).toEqual(["just a line"]);
  });

  it("never splits a fenced code block open", () => {
    const body = Array.from({ length: 80 }, (_, i) => `line ${i} of the query`);
    const reply = ["Here is the query:", "```sql", ...body, "```"].join("\n");
    const chunks = chunkText(reply, 400);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // Every chunk must have balanced fences, or Discord renders the rest of
      // the conversation as code.
      const fences = (chunk.match(/^\s*```/gm) ?? []).length;
      expect(fences % 2).toBe(0);
    }
  });

  it("reopens the block with the same language after a split", () => {
    const body = Array.from({ length: 60 }, (_, i) => `select ${i};`);
    const chunks = chunkText(["```sql", ...body, "```"].join("\n"), 300);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks.slice(1)) {
      expect(chunk.startsWith("```sql")).toBe(true);
    }
  });

  it("splits plain prose on line boundaries", () => {
    const reply = Array.from({ length: 50 }, (_, i) => `sentence ${i}`).join("\n");
    const chunks = chunkText(reply, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(200);
    expect(chunks.join("\n")).toContain("sentence 49");
  });

  it("breaks a single oversized line rather than exceeding the limit", () => {
    const chunks = chunkText("x".repeat(1000), 100);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(100);
    expect(chunks.join("").length).toBe(1000);
  });

  it("preserves markdown structure across a split", () => {
    const reply = [
      "## Spending",
      ...Array.from({ length: 40 }, (_, i) => `- item ${i}`),
    ].join("\n");
    const chunks = chunkText(reply, 250);
    expect(chunks[0]).toContain("## Spending");
    expect(chunks.join("\n")).toContain("- item 39");
  });
});
