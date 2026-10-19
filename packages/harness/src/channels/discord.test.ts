import type {
  ActionRowBuilder,
  ButtonBuilder,
  EmbedBuilder,
  Interaction,
  Message,
} from "discord.js";
import { ChannelType, MessageFlags, OverwriteType, PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import {
  ALWAYS_PREFIX,
  APPROVE_PREFIX,
  DENY_PREFIX,
  DiscordAdapter,
  PRESS_PREFIX,
  bindingOf,
  boundKeyOf,
  webhookNameFor,
  approvalCustomIds,
  approvalText,
  noPreviews,
  settledText,
  storyText,
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
      always: `${ALWAYS_PREFIX}p1`,
    });
  });

  it("round-trips an approve decision", () => {
    const { approve } = approvalCustomIds("abc");
    expect(parseApprovalCustomId(approve)).toEqual({ id: "abc", approved: true });
  });

  it("round-trips an always decision as an approval that is remembered", () => {
    const ids = approvalCustomIds("12");
    expect(parseApprovalCustomId(ids.always)).toEqual({ id: "12", approved: true, remember: true });
    expect(parseApprovalCustomId(ids.approve)).toEqual({ id: "12", approved: true });
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

  it("links a card's references where Discord renders markdown, and tidies them where it does not", () => {
    // A recap's card showed @file:… and @page:… raw: only the words above a
    // card were linked, never the card.
    const embed = buildCard(
      {
        title: "Weekend recap for @project:workout_tracker",
        body: "Five written: @file:blobs/recap/blob.md. See @page:book_crm_home.",
        fields: [{ name: "Next: @schedule:[blob:recap]", value: "@schedule:[blob:recap] fires at 18:00" }],
        footer: "Verified against @file:.kos/daemon.log",
      },
      { dashboardUrl: "https://kos.example/" },
    ).toJSON();
    expect(embed.title).toBe("Weekend recap for workout_tracker");
    expect(embed.description).toBe(
      "Five written: [blobs/recap/blob.md](https://kos.example/#/files/blobs%2Frecap%2Fblob.md). See [book_crm_home](https://kos.example/#/page/book_crm_home).",
    );
    expect(embed.fields).toEqual([{ name: "Next: blob:recap", value: "[blob:recap](https://kos.example/#/schedule) fires at 18:00" }]);
    expect(embed.footer?.text).toBe("Verified against .kos/daemon.log");
    // Nowhere to link to: the names alone, in bold where markdown renders.
    expect(buildCard({ body: "see @page:home" }).toJSON().description).toBe("see **home**");
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

describe("staying up", () => {
  it("listens for gateway errors so one cannot bring the host down", () => {
    const adapter = new DiscordAdapter({ token: "t" });
    const client = (adapter as unknown as { client: { listenerCount(e: string): number } }).client;
    expect(client.listenerCount("error")).toBeGreaterThan(0);
    expect(client.listenerCount("shardError")).toBeGreaterThan(0);
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
    reactions: string[];
  } {
    // "edits" by history: these are the messages posted into the DM, since
    // the answer is a message of its own rather than an edited placeholder.
    const edits: Record<string, unknown>[] = [];
    const reactions: string[] = [];
    const message = {
      author: { id: "owner-id", bot: false },
      guild: null,
      content: "hi",
      react: async (emoji: string) => {
        reactions.push(emoji);
      },
      reactions: { cache: { get: () => undefined } },
      channel: {
        // A posted message can be edited later: the story is one of those.
        send: async (payload: Record<string, unknown>) => {
          edits.push(payload);
          return {
            edit: async (next: Record<string, unknown>) => {
              edits.push({ edit: true, ...next });
            },
          };
        },
      },
    } as unknown as Message;
    const adapter = new DiscordAdapter({ token: "t" });
    // react() reaches for the bot's own user when swapping reactions.
    (adapter as unknown as { client: { user: unknown } }).client.user = { id: "bot" };
    return { adapter, edits, message, reactions };
  }

  it("posts nothing until the answer: the reaction is the whole presence", async () => {
    // A "Working on it…" embed used to be posted and edited into the reply.
    // The owner's phone buzzed for the placeholder and never for the answer,
    // which arrived as an edit, and every reply sat under a titled box.
    const { adapter, edits, message, reactions } = presenceFor();
    const presence = await adapter.acknowledge({ channel: "discord", senderId: "owner-id", text: "hi", native: message });
    expect(edits).toEqual([]);
    expect(reactions).toEqual(["⏳"]);
    await presence!.complete({ text: "done" });
    expect(reactions).toEqual(["⏳", "✅"]);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toEqual({ content: "done" });
  });

  it("tells the turn's story in one silent message, edited as it goes, and leaves it standing when the answer lands", async () => {
    const { adapter, edits, message } = presenceFor();
    const presence = await adapter.acknowledge({ channel: "discord", senderId: "owner-id", text: "hi", native: message });
    await presence!.update("I'll look at the folder.\n› List projects/x");
    // Silent, so the owner's phone buzzes for the answer and not for this.
    // No marker in the words: the reaction says the turn is going, and a
    // "⏳" before a step line left "⏳ -# ›" on the screen, since subtext
    // renders only at the start of a line.
    expect(edits[0]).toEqual({ content: "I'll look at the folder.\n-# › List projects/x", flags: MessageFlags.SuppressNotifications });
    await presence!.update("I'll look at the folder.\n› List projects/x\nTwo stale builds, I'll clear them.\n› Run: rm -rf build");
    expect(edits[1]).toEqual({ edit: true, content: "I'll look at the folder.\n-# › List projects/x\nTwo stale builds, I'll clear them.\n-# › Run: rm -rf build" });
    await presence!.update("› Read config");
    expect(edits[2]).toEqual({ edit: true, content: "-# › Read config" });
    await presence!.complete({ text: "Cleared two stale builds." });
    // The story stays as it was told, with no closing edit; the answer is its own message.
    expect(edits[3]).toEqual({ content: "Cleared two stale builds." });
    expect(edits).toHaveLength(4);
    expect(storyText("x".repeat(3000)).length).toBe(1900);
    // A reference in the story links as it does in the answer, so the same
    // name is not a token in one message and a link in the next.
    expect(storyText("Reading it.\n› Read @page:home", "https://kos.example")).toBe("Reading it.\n-# › Read [home](<https://kos.example/#/page/home>)");
    // A file a step names opens from the story: the path links to it on the dashboard.
    expect(storyText("› Read blobs/verity/blob.md", "https://kos.example")).toBe("-# › Read [blobs/verity/blob.md](<https://kos.example/#/files/blobs%2Fverity%2Fblob.md>)");
    // A time as written is read in the owner's zone and goes out as Discord's own token; code is left alone.
    const late = Date.UTC(2026, 9, 19, 3, 42) / 1000;
    expect(storyText("Due <t:2026-10-18T23:42:R>, `<t:2026-10-18T23:42:R>` as typed", undefined, "America/Toronto")).toBe(`Due <t:${late}:R>, \`<t:2026-10-18T23:42:R>\` as typed`);
  });

  it("links a reference in the reply to the dashboard, since Discord cannot draw the chip", async () => {
    const { adapter, edits, message } = presenceFor();
    (adapter as unknown as { dashboardUrl: string }).dashboardUrl = "https://kos.example";
    const presence = await adapter.acknowledge({ channel: "discord", senderId: "owner-id", text: "hi", native: message });
    await presence!.complete({ text: "Done: @page:book_crm_home and @schedule:[Email Amy Reminder]" });
    // The targets in angle brackets, so Discord draws no preview card.
    expect(edits[0]?.content).toBe(
      "Done: [book_crm_home](<https://kos.example/#/page/book_crm_home>) and [Email Amy Reminder](<https://kos.example/#/schedule>)",
    );
  });

  it("sends every link in angle brackets, so nothing unfurls into a card", async () => {
    // A denied fetch of a wiki page came back with the wiki's own preview
    // card under it: Discord had fetched the page KOS was told not to.
    expect(noPreviews("see https://a.example/x and https://b.example/y?z=1.")).toBe("see <https://a.example/x> and <https://b.example/y?z=1.>");
    expect(noPreviews("[home](https://kos.example/#/page/home) and <https://c.example> stay")).toBe("[home](<https://kos.example/#/page/home>) and <https://c.example> stay");
    expect(noPreviews("`https://in.code` and ```\nhttps://in.block\n```")).toBe("`https://in.code` and ```\nhttps://in.block\n```");
    expect(settledText("denied", "HTTP fetch https://verityminecraft.fandom.com/wiki/Veritypedia", "219")).toBe("-# ❌ Denied · HTTP fetch <https://verityminecraft.fandom.com/wiki/Veritypedia>");
    const { adapter, edits, message } = presenceFor();
    const presence = await adapter.acknowledge({ channel: "discord", senderId: "owner-id", text: "hi", native: message });
    await presence!.complete({ text: "Read https://news.ycombinator.com/ for you." });
    expect(edits.at(-1)?.content).toBe("Read <https://news.ycombinator.com/> for you.");
  });

  it("sends the files a message carries as uploads, under the whole message", async () => {
    const { adapter, edits, message } = presenceFor();
    const presence = await adapter.acknowledge({ channel: "discord", senderId: "owner-id", text: "hi", native: message });
    await presence!.complete({ text: "> can you access this\n-# you, on the dashboard", files: [{ name: "receipt.png", mediaType: "image/png", data: Buffer.from("png bytes").toString("base64") }] });
    const sent = edits.at(-1) as { content: string; files: { attachment: Buffer; name: string }[] };
    expect(sent.content).toBe("> can you access this\n-# you, on the dashboard");
    expect(sent.files.map((f) => [f.name, f.attachment.toString("utf8")])).toEqual([["receipt.png", "png bytes"]]);
    // A file alone is a message too.
    await presence!.complete({ files: [{ name: "a.txt", mediaType: "text/plain", data: Buffer.from("a").toString("base64") }] });
    expect((edits.at(-1) as { content?: string; files: unknown[] }).content).toBeUndefined();
    expect((edits.at(-1) as { files: unknown[] }).files).toHaveLength(1);
  });

  it("says a failure in one plain line, marked", async () => {
    const { adapter, edits, message, reactions } = presenceFor();
    const presence = await adapter.acknowledge({ channel: "discord", senderId: "owner-id", text: "hi", native: message });
    await presence!.fail("Something went wrong handling that.");
    expect(reactions.at(-1)).toBe("❌");
    expect(edits).toEqual([{ content: "❌ Something went wrong handling that." }]);
  });

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
    expect(final.embeds).toBeUndefined();
    expect(final.components).toBeUndefined();
  });

  it("tags a blob's answer with its name, and gives its card the blob's colour", async () => {
    const { adapter, edits, message } = presenceFor();
    const presence = await adapter.acknowledge({ channel: "discord", senderId: "owner-id", text: "hi", native: message });
    const from = { name: "Recap", colour: "#3b82f6" };
    // Words open with the name in bold: the bot is KOS, the speaker is not.
    await presence!.complete({ text: "Done for today.", from });
    expect(edits.at(-1)).toEqual({ content: "**Recap**\nDone for today." });
    // A card alone carries the name as its author, and the colour as its stripe.
    await presence!.complete({ text: "", card: { title: "Today" }, from });
    const alone = (edits.at(-1)!.embeds as EmbedBuilder[])[0]!.toJSON();
    expect(alone.author?.name).toBe("Recap");
    expect(alone.color).toBe(0x3b82f6);
    // With words to carry the name, the card keeps only the colour, and a colour of its own wins.
    await presence!.complete({ text: "Here.", card: { title: "Today", color: 0x111111 }, from });
    expect(edits.at(-1)!.content).toBe("**Recap**\nHere.");
    const under = (edits.at(-1)!.embeds as EmbedBuilder[])[0]!.toJSON();
    expect(under.author).toBeUndefined();
    expect(under.color).toBe(0x111111);
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

describe("the approval prompt", () => {
  /*
   * Two lines and the buttons. The embed this replaced had a title, a
   * description, three fields, a footer and a plain copy above it.
   */
  it("says the action, then the small print as subtext", () => {
    const text = approvalText({
      id: "12",
      text: "x",
      tool: "shell.run",
      args: { command: "rm -rf build", cwd: "/w" },
      reason: "deletes files",
    });
    expect(text.split("\n")).toEqual(["**Needs your OK** · Run", "```", "rm -rf build (in /w)", "```", "-# shell.run · #12 · deletes files"]);
  });

  it("keeps a command literal, whatever Discord would make of its characters", () => {
    const text = approvalText({ id: "132", text: "x", tool: "shell.run", args: { command: 'grep -rn "fell due" --include=*.ts --include=*_x_' } });
    expect(text).toContain('```\ngrep -rn "fell due" --include=*.ts --include=*_x_\n```');
    expect(text.split("\n")[0]).toBe("**Needs your OK** · Run");
  });

  it("puts the arguments in the block when the summary is all sentence", () => {
    const text = approvalText({ id: "5", text: "x", tool: "systems.project_delete", args: { slug: "old_site" } });
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^\*\*Needs your OK\*\* · Delete project/);
    expect(lines.slice(1, 4)).toEqual(["```", "slug: old_site", "```"]);
    expect(lines[4]).toBe("-# systems.project_delete · #5");
  });

  it("settles with the verb and the thing in inline code", () => {
    expect(settledText("approved", "Run: rm -rf build (in /w)", "12")).toBe("-# ✅ Approved · Run `rm -rf build (in /w)`");
    expect(settledText("denied", undefined, "7")).toBe("-# ❌ Denied · #7");
    expect(settledText("expired", "Run: rm x", "8")).toBe("-# ⌛ Lapsed · Run `rm x`");
  });

  it("says who is asking, in the headline", () => {
    // A prompt that said only "Needs your OK · Run" left the owner deciding
    // for nobody in particular: a blob, a project's chat and KOS itself all
    // asked in the same voice.
    const text = approvalText({ id: "209", text: "x", tool: "shell.run", args: { command: "sqlite3 kos.sqlite 'select 1'" }, asker: { name: "Recap", conversationId: "agent:recap" } });
    expect(text.split("\n")[0]).toBe("**Recap needs your OK** · Run");
    expect(approvalText({ id: "3", text: "Post to #general?", asker: { name: "Date Planner", conversationId: "project:date_planner" } }).split("\n")[0]).toBe("**Date Planner needs your OK** · Post to #general?");
    expect(approvalText({ id: "4", text: "x", tool: "files.rm", args: { path: "a" }, asker: { name: "A_b*c", conversationId: "x" } }).split("\n")[0]).toContain("A\\_b\\*c needs your OK");
  });

  it("keeps a text-only request as it was given", () => {
    expect(approvalText({ id: "3", text: "Post to #general?" })).toBe("**Needs your OK** · Post to #general?\n-# #3");
    // What KOS was saying comes first, as one quoted line, so the card is a sentence and not a command.
    expect(approvalText({ id: "4", text: "x", tool: "shell.run", args: { command: "rm -rf build" }, why: "I'll clear the build folder\nso the rebuild is clean." })).toBe(
      "> I'll clear the build folder so the rebuild is clean.\n**Needs your OK** · Run\n```\nrm -rf build\n```\n-# shell.run · #4",
    );
  });

  it("sends no embed, only the two lines and the buttons", async () => {
    const payloads: Record<string, unknown>[] = [];
    const adapter = new DiscordAdapter({ token: "t" });
    (adapter as unknown as { client: { users: unknown } }).client = {
      users: { fetch: async () => ({ send: async (p: Record<string, unknown>) => { payloads.push(p); return { edit: async () => undefined }; } }) },
    };
    await adapter.requestApproval("owner-id", { id: "7", text: "x", tool: "files.rm", args: { path: "a.txt" } });
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.embeds).toBeUndefined();
    // The sentence, the command in its block, the small print.
    const lines = String(payloads[0]?.content).split("\n");
    expect(lines[0]).toMatch(/^\*\*Needs your OK\*\*/);
    expect(lines[lines.length - 1]).toMatch(/^-# /);
    expect(lines.length).toBeLessThanOrEqual(5);
    expect((payloads[0]?.components as unknown[])).toHaveLength(1);
  });
});

describe("a prompt with a picture", () => {
  it("attaches the page the action is aimed at", async () => {
    const payloads: Record<string, unknown>[] = [];
    const adapter = new DiscordAdapter({ token: "t" });
    (adapter as unknown as { client: { users: unknown } }).client = {
      users: { fetch: async () => ({ send: async (p: Record<string, unknown>) => { payloads.push(p); return { edit: async () => undefined }; } }) },
    };
    await adapter.requestApproval("owner-id", { id: "7", text: "x", tool: "mcp.browser.agent_browser_click", args: { selector: "@e5" }, reason: "on shop.example", picture: "UElD" });
    const files = payloads[0]?.files as { name: string; attachment: Buffer }[];
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe("page.jpg");
    expect(files[0]?.attachment.toString("utf8")).toBe("PIC");
    expect(String(payloads[0]?.content)).toContain("Click @e5");
    expect(String(payloads[0]?.content)).toContain("on shop.example");
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
    // One small line, with what it was: the buttons and the prompt are gone.
    expect(edits[0]?.content).toBe("-# ✅ Approved · Approve sql?");
  });

  it("says denied when it was denied", async () => {
    const { adapter, edits } = adapterWithPrompt();
    await adapter.requestApproval("owner-id", { id: "8", text: "Approve sql?" });
    await adapter.settleApproval("8", "denied");
    expect(edits[0]?.content).toBe("-# ❌ Denied · Approve sql?");
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

  it("in its server, takes the owner's words in a bound channel to the conversation the topic names", async () => {
    const adapter = new DiscordAdapter({ token: "t", guildId: "g1" });
    const messages: InboundMessage[] = [];
    adapter.setAuthorizer((senderId) => senderId === "owner-id");
    adapter.onMessage((msg) => {
      messages.push(msg);
    });
    const inGuild = (authorId: string, guildId: string, channel: Record<string, unknown>, content = "plan the week"): Message =>
      ({ author: { id: authorId, bot: false }, guild: { id: guildId }, channel, content, attachments: undefined } as unknown as Message);
    const project = { id: "c1", name: "garden", topic: "kos:project:garden · Garden", isThread: () => false };
    await adapter.receiveMessage(inGuild("owner-id", "g1", project));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ senderId: "owner-id", text: "plan the week", conversationId: "project:garden" });
    expect(messages[0]).not.toHaveProperty("newIn");
    // A thread under a project's channel is a chat of that project, titled as the thread.
    await adapter.receiveMessage(inGuild("owner-id", "g1", { id: "t9", name: "Seeds", isThread: () => true, parent: { topic: "kos:project:garden · Garden" } }));
    expect(messages[1]).toMatchObject({ conversationId: "discord:thread:t9", newIn: { projectSlug: "garden", title: "Seeds" } });
    // A thread under a blob's channel is the blob's own thread.
    await adapter.receiveMessage(inGuild("owner-id", "g1", { id: "t10", name: "x", isThread: () => true, parent: { topic: "kos:agent:recap · Recap" } }));
    expect(messages[2]).toMatchObject({ conversationId: "agent:recap" });
    // Another server, an unbound channel, the approvals channel, or anyone but the owner: nothing.
    await adapter.receiveMessage(inGuild("owner-id", "g2", project));
    await adapter.receiveMessage(inGuild("owner-id", "g1", { id: "c5", name: "general", topic: "chit chat", isThread: () => false }));
    await adapter.receiveMessage(inGuild("owner-id", "g1", { id: "c6", name: "needs-you", topic: "kos:needs-you · Approvals", isThread: () => false }));
    await adapter.receiveMessage(inGuild("stranger", "g1", project));
    expect(messages).toHaveLength(3);
    // Without a server configured, a server message is ignored whoever sent it.
    const dmOnly = new DiscordAdapter({ token: "t" });
    const seen: InboundMessage[] = [];
    dmOnly.setAuthorizer(() => true);
    dmOnly.onMessage((msg) => {
      seen.push(msg);
    });
    await dmOnly.receiveMessage(inGuild("owner-id", "g1", project));
    expect(seen).toEqual([]);
  });

  it("reads a channel's binding from its topic", () => {
    expect(boundKeyOf("kos:project:garden · Garden")).toBe("project:garden");
    expect(boundKeyOf("Garden")).toBeUndefined();
    expect(bindingOf({ id: "c", topic: "kos:orchestrator:owner · KOS" })).toEqual({ conversationId: "orchestrator:owner" });
    expect(bindingOf({ id: "t", name: "Ideas", isThread: () => true, parent: { topic: "kos:orchestrator:owner · KOS" } })).toEqual({ conversationId: "discord:thread:t", newIn: { title: "Ideas" } });
    expect(bindingOf({ id: "t", isThread: () => true, parent: { topic: "kos:needs-you · Approvals" } })).toBeUndefined();
    expect(bindingOf({ id: "t", isThread: () => true, parent: null })).toBeUndefined();
  });

  it("lays the plan out as channels under a KOS category, keeping what is there", async () => {
    const adapter = new DiscordAdapter({ token: "t", guildId: "g1", ownerId: "owner-id" });
    const existing = new Map<string, Record<string, unknown>>([
      ["cat", { id: "cat", type: ChannelType.GuildCategory, name: "kos" }],
      ["c1", { id: "c1", type: ChannelType.GuildText, name: "my-garden", topic: "kos:project:garden · Garden" }],
      ["c5", { id: "c5", type: ChannelType.GuildText, name: "general", topic: null }],
    ]);
    const created: Record<string, unknown>[] = [];
    const guild = {
      id: "g1",
      channels: {
        fetch: async () => existing,
        create: async (opts: Record<string, unknown>) => {
          const made = { id: `new-${created.length + 1}`, ...opts };
          created.push(made);
          return made;
        },
      },
    };
    const sent: Record<string, unknown>[] = [];
    (adapter as unknown as { client: unknown }).client = {
      guilds: { fetch: async (id: string) => (id === "g1" ? guild : undefined) },
      channels: { fetch: async (id: string) => (id === "new-2" ? { isSendable: () => true, send: async (p: Record<string, unknown>) => { sent.push(p); return { edit: async () => undefined }; } } : undefined) },
      users: { fetch: async () => ({ send: async () => { throw new Error("the DM must not be used once the server has an approvals channel"); } }) },
    };
    const result = await adapter.sync([
      { key: "orchestrator:owner", name: "kos", topic: "kos:orchestrator:owner · KOS", category: "KOS" },
      { key: "needs-you", name: "needs-you", topic: "kos:needs-you · Approvals", category: "KOS" },
      { key: "project:garden", name: "garden", topic: "kos:project:garden · Garden", category: "Projects" },
    ]);
    // The renamed project channel is kept by its binding; the rest are made under their categories,
    // and the one category that was missing is made first, owner-only.
    expect(result).toEqual({ created: ["kos", "needs-you"], kept: ["my-garden"], threads: [] });
    const texts = created.filter((c) => c["type"] === ChannelType.GuildText);
    expect(texts.map((c) => [c["name"], c["parent"], c["topic"]])).toEqual([
      ["kos", "cat", "kos:orchestrator:owner · KOS"],
      ["needs-you", "cat", "kos:needs-you · Approvals"],
    ]);
    expect(created.filter((c) => c["type"] === ChannelType.GuildCategory).map((c) => c["name"])).toEqual(["Projects"]);
    // Made for the owner's eyes: everyone else is kept out, the owner and the bot let in.
    const overwrites = texts[0]!["permissionOverwrites"] as { id: string; type: OverwriteType; allow?: bigint[]; deny?: bigint[] }[];
    expect(overwrites[0]).toEqual({ id: "g1", type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] });
    expect(overwrites.find((o) => o.id === "owner-id")?.type).toBe(OverwriteType.Member);
    expect(overwrites.find((o) => o.id === "owner-id")?.allow).toContain(PermissionFlagsBits.SendMessages);
    // From now on an ask goes to the approvals channel, buttons and all.
    await adapter.requestApproval("owner-id", { id: "7", text: "x", tool: "files.rm", args: { path: "a.txt" }, asker: { name: "Garden", conversationId: "project:garden" } });
    expect(sent).toHaveLength(1);
    expect(String(sent[0]?.content).split("\n")[0]).toBe("**Garden needs your OK** · Delete a.txt");
    expect(sent[0]?.components).toHaveLength(1);
    // No server: nothing to lay out.
    expect(await new DiscordAdapter({ token: "t" }).sync([])).toEqual({ created: [], kept: [], threads: [] });
  });

  it("moves a channel under its category and makes a thread per chat, once", async () => {
    const adapter = new DiscordAdapter({ token: "t", guildId: "g1", ownerId: "owner-id" });
    const moved: string[] = [];
    const threadsMade: { name: string; reason?: string }[] = [];
    const garden = {
      id: "c1",
      name: "garden",
      topic: "kos:project:garden · Garden",
      type: ChannelType.GuildText,
      parentId: "kos-cat",
      permissionOverwrites: { cache: new Map([["g1", { deny: { has: () => true } }]]), set: async () => undefined },
      setParent: async (parent: string) => {
        moved.push(parent);
      },
      threads: {
        create: async (o: { name: string; reason?: string }) => {
          threadsMade.push(o);
          return { id: `t${threadsMade.length}` };
        },
      },
    };
    const existing = new Map<string, Record<string, unknown>>([
      ["kos-cat", { id: "kos-cat", type: ChannelType.GuildCategory, name: "KOS" }],
      ["proj-cat", { id: "proj-cat", type: ChannelType.GuildCategory, name: "Projects" }],
      ["c1", garden],
    ]);
    (adapter as unknown as { client: unknown }).client = {
      user: { id: "bot" },
      guilds: { fetch: async () => ({ id: "g1", channels: { fetch: async () => existing, create: async () => { throw new Error("nothing to make"); } } }) },
    };
    const plan = [{ key: "project:garden", name: "garden", topic: "x", category: "Projects", threads: [{ conversationId: "chat-a", title: "Seeds" }, { conversationId: "chat-b", title: "Soil" }] }];
    const first = await adapter.sync(plan);
    // From the KOS category to Projects, keeping its own permissions; a thread for each chat.
    expect(moved).toEqual(["proj-cat"]);
    expect(first.threads).toEqual([
      { threadId: "t1", conversationId: "chat-a", title: "Seeds" },
      { threadId: "t2", conversationId: "chat-b", title: "Soil" },
    ]);
    expect(threadsMade.map((t) => t.reason)).toEqual(["KOS: chat-a", "KOS: chat-b"]);
    // Told what the kernel kept, the next layout makes no thread twice.
    adapter.rememberThreads({ t1: "chat-a", t2: "chat-b" });
    expect((await adapter.sync(plan)).threads).toEqual([]);
    expect(threadsMade).toHaveLength(2);
    // The listing says where each channel sits.
    expect(await adapter.channels()).toEqual([{ key: "project:garden", name: "garden", audience: "owner", category: "kos" }]);
    // A thread the kernel knows is that chat, whatever its parent says.
    expect(bindingOf({ id: "t1", name: "Seeds", isThread: () => true, parent: { topic: "kos:project:garden" } }, (id) => (id === "t1" ? "chat-a" : undefined))).toEqual({ conversationId: "chat-a" });
    // Where a chat shows: its bound channel, or the thread made for it, or nowhere.
    expect(adapter.mirrorTarget("project:garden", {})).toBe("c1");
    expect(adapter.mirrorTarget("chat-a", { t1: "chat-a" })).toBe("t1");
    expect(adapter.mirrorTarget("chat-z", { t1: "chat-a" })).toBeUndefined();
  });

  it("gives a blob with a face a webhook of its own, wearing it, and redraws it when the face changes", async () => {
    const adapter = new DiscordAdapter({ token: "t", guildId: "g1" });
    const made: { name: string; avatar?: string }[] = [];
    const edited: { name: string; avatar?: string }[] = [];
    const hooks = new Map<string, { name: string; token: string; send: (p: unknown) => Promise<unknown>; edit: (o: { name: string; avatar?: string }) => Promise<unknown> }>();
    const hookNamed = (name: string) => {
      const h = {
        name,
        token: "wh",
        send: async () => ({}),
        edit: async (o: { name: string; avatar?: string }) => {
          edited.push(o);
          h.name = o.name;
          return h;
        },
      };
      return h;
    };
    const channel = {
      id: "c2",
      isThread: () => false,
      isSendable: () => true,
      send: async () => ({}),
      fetchWebhooks: async () => hooks,
      createWebhook: async (o: { name: string; avatar?: string }) => {
        made.push(o);
        const h = hookNamed(o.name);
        hooks.set(`w${hooks.size + 1}`, h);
        return h;
      },
    };
    (adapter as unknown as { client: { channels: unknown } }).client = { channels: { fetch: async () => channel } };
    const recap = { name: "Recap", colour: "#3b82f6", avatar: "AAAA" };
    // Made once, named for the blob with a hash of its face, wearing the face.
    await adapter.postIn("c2", { text: "one", from: recap });
    await adapter.postIn("c2", { text: "two", from: recap });
    expect(made).toEqual([{ name: webhookNameFor(recap), avatar: "data:image/png;base64,AAAA" }]);
    expect(made[0]!.name.startsWith("KOS·Recap·")).toBe(true);
    // A new face: the blob's webhook is given it rather than a second one made.
    const newFace = { ...recap, avatar: "BBBB" };
    await adapter.postIn("c2", { text: "three", from: newFace });
    expect(made).toHaveLength(1);
    expect(edited).toEqual([{ name: webhookNameFor(newFace), avatar: "data:image/png;base64,BBBB" }]);
    // A blob with no face shares the plain KOS webhook.
    await adapter.postIn("c2", { text: "four", from: { name: "Watch" } });
    expect(made.at(-1)).toEqual({ name: "KOS" });
  });

  it("shows a turn taken elsewhere in the chat's thread, as KOS or as the blob", async () => {
    const adapter = new DiscordAdapter({ token: "t", guildId: "g1" });
    const posted: Record<string, unknown>[] = [];
    const viaHook: Record<string, unknown>[] = [];
    const hook = { name: "KOS", token: "wh", send: async (p: Record<string, unknown>) => { viaHook.push(p); return {}; } };
    const parent = { id: "c2", fetchWebhooks: async () => new Map([["w1", hook]]), createWebhook: async () => { throw new Error("one exists"); } };
    const thread = { id: "t1", isThread: () => true, parent, isSendable: () => true, send: async (p: Record<string, unknown>) => { posted.push(p); return {}; } };
    (adapter as unknown as { client: unknown }).client = { channels: { fetch: async (id: string) => (id === "t1" ? thread : id === "c2" ? parent : undefined) } };
    // The owner's words from the dashboard, as the bot; the blob's answer under its own name, into the thread through its parent's webhook.
    await adapter.postIn("t1", { text: "> what did I do?\n-# you, on the dashboard" });
    await adapter.postIn("t1", { text: "Three things.", from: { name: "Recap", colour: "#3b82f6" } });
    expect(posted).toEqual([{ content: "> what did I do?\n-# you, on the dashboard" }]);
    expect(viaHook).toEqual([{ content: "Three things.", username: "Recap", threadId: "t1" }]);
    await expect(adapter.postIn("nope", { text: "x" })).rejects.toThrow(/not somewhere this bot can post/);
  });

  it("keeps a channel's permissions to its audience, and opens or closes one on request", async () => {
    const adapter = new DiscordAdapter({ token: "t", guildId: "g1", ownerId: "owner-id" });
    const applied: Record<string, { id: string; allow?: bigint[]; deny?: bigint[] }[][]> = {};
    const text = (id: string, name: string, topic: string, denyEveryone: boolean) => ({
      id,
      name,
      topic,
      type: ChannelType.GuildText,
      permissionOverwrites: {
        cache: new Map(denyEveryone ? [["g1", { deny: { has: (bit: bigint) => bit === PermissionFlagsBits.ViewChannel } }]] : []),
        set: async (o: { id: string; allow?: bigint[]; deny?: bigint[] }[]) => {
          (applied[id] ??= []).push(o);
        },
      },
    });
    const existing = new Map<string, Record<string, unknown>>([
      ["cat", { id: "cat", type: ChannelType.GuildCategory, name: "KOS" }],
      ["c1", text("c1", "garden", "kos:project:garden · Garden", true)],
      ["c2", text("c2", "recap", "kos:agent:recap · Recap", false)],
    ]);
    (adapter as unknown as { client: unknown }).client = {
      user: { id: "bot" },
      guilds: { fetch: async () => ({ id: "g1", channels: { fetch: async () => existing, create: async () => { throw new Error("nothing to make"); } } }) },
    };
    // The list reads each channel's audience off its permissions.
    expect(await adapter.channels()).toEqual([
      { key: "project:garden", name: "garden", audience: "owner" },
      { key: "agent:recap", name: "recap", audience: "everyone" },
    ]);
    // A sync puts a drifted channel back to what the plan says, and leaves the others alone.
    await adapter.sync([
      { key: "project:garden", name: "garden", topic: "x", category: "KOS", audience: "owner" },
      { key: "agent:recap", name: "recap", topic: "x", category: "KOS", audience: "owner" },
    ]);
    expect(applied["c1"]).toBeUndefined();
    expect(applied["c2"]?.[0]?.[0]).toEqual({ id: "g1", type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] });
    // Opened to everyone: they may read and not write; the owner and the bot keep everything.
    expect(await adapter.setAudience("project:garden", "everyone")).toEqual({ key: "project:garden", name: "garden", audience: "everyone" });
    const opened = applied["c1"]![0]!;
    expect(opened[0]).toEqual({ id: "g1", type: OverwriteType.Role, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: expect.arrayContaining([PermissionFlagsBits.SendMessages]) });
    expect(opened.map((o) => o.id)).toEqual(["g1", "owner-id", "bot"]);
    await expect(adapter.setAudience("project:nope", "owner")).rejects.toThrow(/no channel is bound/);
  });

  it("answers as the blob itself in a server channel, through the channel's webhook", async () => {
    const adapter = new DiscordAdapter({ token: "t", guildId: "g1" });
    (adapter as unknown as { client: { user: unknown } }).client.user = { id: "bot" };
    const posted: Record<string, unknown>[] = [];
    const viaHook: Record<string, unknown>[] = [];
    const hook = { name: "KOS", token: "wh", send: async (p: Record<string, unknown>) => { viaHook.push(p); return {}; } };
    const channel = {
      id: "c2",
      isThread: () => false,
      send: async (p: Record<string, unknown>) => { posted.push(p); return { edit: async () => undefined }; },
      fetchWebhooks: async () => new Map([["w1", hook]]),
      createWebhook: async () => { throw new Error("one exists"); },
    };
    (adapter as unknown as { client: { channels: unknown } }).client.channels = { fetch: async (id: string) => (id === "c2" ? channel : undefined) };
    const message = {
      author: { id: "owner-id", bot: false },
      guild: { id: "g1" },
      channel,
      content: "what did I get done",
      react: async () => undefined,
      reactions: { cache: { get: () => undefined } },
    } as unknown as Message;
    const presence = await adapter.acknowledge({ channel: "discord", senderId: "owner-id", text: "what did I get done", native: message });
    await presence!.complete({ text: "Three things, all shipped.", from: { name: "Recap", colour: "#3b82f6" } });
    // Under the blob's name, with no tag line, and not through the bot's own post.
    expect(viaHook).toEqual([{ content: "Three things, all shipped.", username: "Recap" }]);
    expect(posted).toEqual([]);
    // KOS's own answer in a server channel is the bot's, as before.
    await presence!.complete({ text: "Done." });
    expect(posted).toEqual([{ content: "Done." }]);
  });

  it("tells a blob's story as the blob in its channel, through its webhook, and edits it there", async () => {
    const verity = { name: "Verity", colour: "#eab308", avatar: "AAAA" };
    const adapter = new DiscordAdapter({ token: "t", guildId: "g1", senderOf: (id) => (id === "agent:verity" ? verity : undefined) });
    (adapter as unknown as { client: { user: unknown } }).client.user = { id: "bot" };
    const posted: Record<string, unknown>[] = [];
    const viaHook: Record<string, unknown>[] = [];
    const edited: [string, Record<string, unknown>][] = [];
    const hook = {
      name: webhookNameFor(verity),
      token: "wh",
      send: async (p: Record<string, unknown>) => { viaHook.push(p); return { id: `m${viaHook.length}` }; },
      editMessage: async (id: string, p: Record<string, unknown>) => { edited.push([id, p]); return {}; },
    };
    const channel = {
      id: "c3",
      isThread: () => false,
      send: async (p: Record<string, unknown>) => { posted.push(p); return { edit: async () => undefined }; },
      fetchWebhooks: async () => new Map([["w1", hook]]),
      createWebhook: async () => { throw new Error("one exists"); },
    };
    (adapter as unknown as { client: { channels: unknown } }).client.channels = { fetch: async (id: string) => (id === "c3" ? channel : undefined) };
    const message = { author: { id: "owner-id", bot: false }, guild: { id: "g1" }, channel, content: "what time is it", react: async () => undefined, reactions: { cache: { get: () => undefined } } } as unknown as Message;
    const presence = await adapter.acknowledge({ channel: "discord", senderId: "owner-id", text: "what time is it", conversationKey: "agent:verity", native: message });
    await presence!.update("› get_current_time on time");
    await presence!.update("› get_current_time on time\nNearly midnight.");
    // Told under the blob's name, silently, and edited through the same webhook; the bot posts nothing.
    expect(viaHook).toEqual([{ content: "-# › get_current_time on time", flags: MessageFlags.SuppressNotifications, username: "Verity" }]);
    expect(edited).toEqual([["m1", { content: "-# › get_current_time on time\nNearly midnight." }]]);
    await presence!.complete({ text: "It is 23:42.", from: verity });
    expect(viaHook[1]).toEqual({ content: "It is 23:42.", username: "Verity" });
    expect(posted).toEqual([]);
    // A thread under the blob's channel posts and edits through the parent's webhook, in the thread.
    const thread = { ...channel, id: "t1", isThread: () => true, parent: channel };
    const inThread = { ...(message as unknown as Record<string, unknown>), channel: thread } as unknown as Message;
    const p2 = await adapter.acknowledge({ channel: "discord", senderId: "owner-id", text: "and now", conversationId: "agent:verity", native: inThread });
    await p2!.update("› Read clock");
    await p2!.update("› Read clock\n› Read calendar");
    expect(viaHook[2]).toMatchObject({ username: "Verity", threadId: "t1" });
    expect(edited[1]).toEqual(["m3", { content: "-# › Read clock\n-# › Read calendar", threadId: "t1" }]);
    // KOS's own story, in a channel with no speaker, is the bot's.
    const kos = await adapter.acknowledge({ channel: "discord", senderId: "owner-id", text: "hi", conversationKey: "orchestrator:owner", native: message });
    await kos!.update("› List projects");
    expect(posted).toEqual([{ content: "-# › List projects", flags: MessageFlags.SuppressNotifications }]);
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
      adapter as unknown as { prompts: Map<string, { message: { edit: () => Promise<void> }; summary: string }> }
    ).prompts.set(id, { message: { edit }, summary: "x" });
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
