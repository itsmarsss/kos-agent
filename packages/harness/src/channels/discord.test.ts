import type {
  ActionRowBuilder,
  ButtonBuilder,
  EmbedBuilder,
  Interaction,
  Message,
} from "discord.js";
import { describe, expect, it, vi } from "vitest";

import {
  APPROVE_PREFIX,
  DENY_PREFIX,
  DiscordAdapter,
  PRESS_PREFIX,
  approvalCustomIds,
  buildButtons,
  buildCard,
  buildModal,
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

describe("the answer a turn shaped", () => {
  /**
   * acknowledge() returns the handle the runtime completes a turn through, so
   * this is where a chosen card actually becomes an embed. Faked down to the
   * two calls that path makes: reply() to post the status, edit() to become
   * the answer.
   */
  function presenceFor(): {
    adapter: DiscordAdapter;
    edits: Record<string, unknown>[];
    message: Message;
  } {
    const edits: Record<string, unknown>[] = [];
    const statusMsg = {
      edit: async (payload: Record<string, unknown>) => {
        edits.push(payload);
        return statusMsg;
      },
    };
    const message = {
      author: { id: "owner-id", bot: false },
      guild: null,
      content: "hi",
      react: async () => undefined,
      reactions: { cache: { get: () => undefined } },
      reply: async () => statusMsg,
    } as unknown as Message;
    const adapter = new DiscordAdapter({ token: "t" });
    // react() reaches for the bot's own user when swapping reactions.
    (adapter as unknown as { client: { user: unknown } }).client.user = { id: "bot" };
    return { adapter, edits, message };
  }

  it("puts the card under the words, in the same message", async () => {
    const { adapter, edits, message } = presenceFor();
    const presence = await adapter.acknowledge({
      channel: "discord",
      senderId: "owner-id",
      text: "hi",
      native: message,
    });
    await presence!.complete({
      text: "you are 40 in",
      card: { title: "Budget" },
      buttons: [{ label: "Rows", token: "t1" }],
    });

    // The last edit is the answer: the text as content, the card as an embed
    // beneath it, and the buttons under both. One message, not three.
    const final = edits.at(-1)!;
    expect(final.content).toBe("you are 40 in");
    expect((final.embeds as EmbedBuilder[])[0]?.toJSON().title).toBe("Budget");
    expect(
      (final.components as ActionRowBuilder<ButtonBuilder>[])[0]?.toJSON()
        .components,
    ).toHaveLength(1);
  });

  it("leaves a plain answer plain", async () => {
    const { adapter, edits, message } = presenceFor();
    const presence = await adapter.acknowledge({
      channel: "discord",
      senderId: "owner-id",
      text: "hi",
      native: message,
    });
    await presence!.complete({ text: "just words" });

    const final = edits.at(-1)!;
    expect(final.content).toBe("just words");
    expect(final.embeds).toEqual([]);
    expect(final.components).toEqual([]);
  });
});

describe("answering a button press", () => {
  /**
   * Discord holds the presser on a spinner and will not hold one for long, so
   * what is being checked is the order: a form can only be shown first, the
   * work has to be acknowledged before it starts, and the answer has to reach
   * the person who pressed rather than the void it used to go to.
   */
  function pressFor(customId: string): {
    adapter: DiscordAdapter;
    interaction: Record<string, unknown>;
    calls: string[];
  } {
    const calls: string[] = [];
    const submitted = {
      customId,
      user: { id: "owner-id" },
      fields: { getTextInputValue: (id: string) => `typed-${id}` },
      deferReply: async (opts?: Record<string, unknown>) => {
        calls.push(`submit.deferReply:${JSON.stringify(opts ?? {})}`);
      },
      editReply: async (payload: Record<string, unknown>) => {
        calls.push(`submit.editReply:${String(payload.content)}`);
      },
      reply: async () => calls.push("submit.reply"),
    };
    const interaction = {
      isButton: () => true,
      customId,
      user: { id: "owner-id" },
      component: { label: "Add a note" },
      deferUpdate: async () => {
        calls.push("deferUpdate");
      },
      deferReply: async (opts?: Record<string, unknown>) => {
        calls.push(`deferReply:${JSON.stringify(opts ?? {})}`);
      },
      editReply: async (payload: Record<string, unknown>) => {
        calls.push(`editReply:${String(payload.content)}`);
      },
      reply: async () => calls.push("reply"),
      showModal: async () => {
        calls.push("showModal");
      },
      awaitModalSubmit: async () => submitted,
    };
    const adapter = new DiscordAdapter({ token: "t" });
    adapter.setAuthorizer((id) => id === "owner-id");
    return { adapter, interaction, calls };
  }

  it("says it is working, then answers the presser", async () => {
    const { adapter, interaction, calls } = pressFor(`${PRESS_PREFIX}tok1`);
    adapter.onButton(async (_press, respond) => {
      await respond.working();
      await respond.send({ text: "done" });
    });
    await adapter.receiveInteraction(interaction as unknown as Interaction);
    // deferReply, not deferUpdate: the answer is a new message, so the one the
    // button sits on keeps its buttons.
    expect(calls).toEqual(["deferReply:{}", "editReply:done"]);
  });

  it("keeps the answer to the presser when the button asked for that", async () => {
    const { adapter, interaction, calls } = pressFor(`${PRESS_PREFIX}tok1`);
    adapter.onButton(async (_press, respond) => {
      await respond.working({ ephemeral: true });
      await respond.send({ text: "just for you" });
    });
    await adapter.receiveInteraction(interaction as unknown as Interaction);
    expect(calls[0]).toContain("deferReply");
    expect(calls[0]).toContain("flags");
  });

  it("shows the form first and hands back what was typed", async () => {
    const { adapter, interaction, calls } = pressFor(`${PRESS_PREFIX}tok1`);
    let got: Record<string, string> | undefined;
    adapter.onButton(async (_press, respond) => {
      got = await respond.openForm({
        title: "A note",
        fields: [{ id: "note", label: "Note" }],
      });
      await respond.working();
      await respond.send({ text: "saved" });
    });
    await adapter.receiveInteraction(interaction as unknown as Interaction);

    expect(got).toEqual({ note: "typed-note" });
    // The form has to come first, and everything after it answers the
    // submission rather than the press, which can no longer be replied to.
    expect(calls).toEqual([
      "showModal",
      "submit.deferReply:{}",
      "submit.editReply:saved",
    ]);
  });

  it("releases the spinner even when the handler says nothing", async () => {
    const { adapter, interaction, calls } = pressFor(`${PRESS_PREFIX}tok1`);
    adapter.onButton(async () => undefined);
    await adapter.receiveInteraction(interaction as unknown as Interaction);
    // Left alone, the presser watches a spinner until Discord gives up and
    // says the interaction failed.
    expect(calls).toEqual(["deferUpdate"]);
  });
});

describe("forms", () => {
  it("builds the boxes it was given", () => {
    const modal = buildModal("kos:form:t1", {
      title: "Log an expense",
      fields: [
        { id: "amount", label: "How much" },
        { id: "note", label: "What for", style: "paragraph", required: false },
      ],
    }).toJSON();
    expect(modal.custom_id).toBe("kos:form:t1");
    expect(modal.title).toBe("Log an expense");
    expect(modal.components).toHaveLength(2);
  });

  it("drops the boxes past what the surface will show", () => {
    // Six fields is a form that does not open at all, which is worse than a
    // form missing its last box.
    const modal = buildModal("f", {
      title: "Many",
      fields: Array.from({ length: 8 }, (_, i) => ({ id: `f${i}`, label: `F${i}` })),
    }).toJSON();
    expect(modal.components).toHaveLength(5);
  });
});

describe("a prompt decided somewhere else", () => {
  function adapterWithPrompt(): {
    adapter: DiscordAdapter;
    edits: Record<string, unknown>[];
  } {
    const edits: Record<string, unknown>[] = [];
    const sent = {
      edit: async (payload: Record<string, unknown>) => {
        edits.push(payload);
        return sent;
      },
    };
    const adapter = new DiscordAdapter({ token: "t" });
    (adapter as unknown as { client: { users: unknown } }).client = {
      users: { fetch: async () => ({ send: async () => sent }) },
    };
    return { adapter, edits };
  }

  it("settles the prompt when the decision came from the dashboard", async () => {
    /*
     * The prompt kept its buttons until Discord was the surface that answered
     * it, so a decision made elsewhere left a message still offering the
     * choice -- and pressing it reported that the action did not exist.
     */
    const { adapter, edits } = adapterWithPrompt();
    await adapter.requestApproval("owner-id", { id: "7", text: "Approve sql?" });
    await adapter.settleApproval("7", "approved");

    expect(edits).toHaveLength(1);
    expect(edits[0]?.components).toEqual([]);
    expect(String(edits[0]?.content)).toContain("Working on that");
  });

  it("says denied when it was denied", async () => {
    const { adapter, edits } = adapterWithPrompt();
    await adapter.requestApproval("owner-id", { id: "8", text: "Approve sql?" });
    await adapter.settleApproval("8", "denied");
    expect(String(edits[0]?.content)).toBe("Denied.");
    expect(edits[0]?.embeds).toEqual([]);
  });

  it("does nothing for a prompt it never sent", async () => {
    const { adapter, edits } = adapterWithPrompt();
    await adapter.settleApproval("99", "approved");
    expect(edits).toEqual([]);
  });

  it("settles a prompt once, not again when the decision echoes back", async () => {
    const { adapter, edits } = adapterWithPrompt();
    await adapter.requestApproval("owner-id", { id: "9", text: "Approve sql?" });
    await adapter.settleApproval("9", "approved");
    await adapter.settleApproval("9", "approved");
    expect(edits).toHaveLength(1);
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

describe("settling a prompt decided somewhere else", () => {
  /** Reach the prompt registry without sending a real Discord message. */
  function seed(adapter: DiscordAdapter, id: string, edit: () => Promise<void>) {
    (
      adapter as unknown as { prompts: Map<string, { edit: () => Promise<void> }> }
    ).prompts.set(id, { edit });
  }

  it("edits the prompt once, then leaves it alone", async () => {
    /*
     * The decision can arrive from the dashboard, in which case the buttons
     * are still on screen and have to go. It can also arrive from this
     * surface, which has already edited the message and dropped the prompt --
     * settling again would rewrite a message that is already correct.
     */
    const adapter = new DiscordAdapter({ token: "t" });
    const edit = vi.fn(async () => undefined);
    seed(adapter, "7", edit);

    await adapter.settleApproval("7", "approved");
    expect(edit).toHaveBeenCalledTimes(1);

    // The prompt is spent. Anything later is a no-op, which is what makes
    // the surface's own decision path safe to leave unguarded.
    await adapter.settleApproval("7", "approved");
    expect(edit).toHaveBeenCalledTimes(1);
  });

  it("says nothing about a prompt it never sent", async () => {
    const adapter = new DiscordAdapter({ token: "t" });
    await expect(adapter.settleApproval("404", "denied")).resolves.toBeUndefined();
  });
});
