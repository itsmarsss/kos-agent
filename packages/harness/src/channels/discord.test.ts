import type { Interaction, Message } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import {
  APPROVE_PREFIX,
  DENY_PREFIX,
  DiscordAdapter,
  approvalCustomIds,
  chunkText,
  parseApprovalCustomId,
} from "./discord.js";
import type { ApprovalDecision, InboundMessage } from "./types.js";

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
  };
}

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
