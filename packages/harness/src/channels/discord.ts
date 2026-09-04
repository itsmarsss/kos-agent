import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  type Interaction,
  type Message,
} from "discord.js";
import {
  formatApprovalPrompt,
  summarizeAction,
} from "@kos/shared";

import { isImage, isTextual, type Attachment } from "../kernel/attachments.js";
import type {
  ApprovalHandler,
  ApprovalRequest,
  ButtonPressHandler,
  ChannelAdapter,
  InboundMessage,
  MessageButton,
  MessageCard,
  MessageHandler,
  MessageTarget,
  OutboundMessage,
  SenderAuthorizer,
  TurnPresence,
} from "./types.js";

export const APPROVE_PREFIX = "kos:approve:";
export const DENY_PREFIX = "kos:deny:";
/** A button the agent put there, as opposed to one the risk gate did. */
export const PRESS_PREFIX = "kos:press:";

const REACT_WORKING = "⏳";
const REACT_DONE = "✅";
const REACT_FAIL = "❌";
const COLOR_WORKING = 0x6366f1;
const COLOR_FAIL = 0xef4444;
const COLOR_APPROVE = 0xf59e0b;

/** Encode the approve/deny button ids for a pending action. */
export function approvalCustomIds(pendingId: string): {
  approve: string;
  deny: string;
} {
  return {
    approve: `${APPROVE_PREFIX}${pendingId}`,
    deny: `${DENY_PREFIX}${pendingId}`,
  };
}

/** Decode a button customId back into an approval decision, or null. */
export function parseApprovalCustomId(
  customId: string,
): { id: string; approved: boolean } | null {
  if (customId.startsWith(APPROVE_PREFIX)) {
    return { id: customId.slice(APPROVE_PREFIX.length), approved: true };
  }
  if (customId.startsWith(DENY_PREFIX)) {
    return { id: customId.slice(DENY_PREFIX.length), approved: false };
  }
  return null;
}

const FENCE = /^\s*```(\w*)\s*$/;

/**
 * Split long replies to Discord's message limit without breaking formatting.
 *
 * Splits on line boundaries, and tracks fenced code blocks: a chunk that ends
 * mid-fence is closed and the next chunk reopens with the same language. A
 * naive split leaves a dangling ``` that swallows the rest of the reply as
 * code, which is exactly the case a long answer with a query in it hits.
 */
export function chunkText(text: string, max = 1900): string[] {
  if (text.length <= max) return [text];

  const chunks: string[] = [];
  const lines = text.split("\n");
  let current: string[] = [];
  let length = 0;
  let fenceLang: string | null = null;

  const flush = (): void => {
    if (current.length === 0) return;
    const body = fenceLang === null ? current : [...current, "```"];
    chunks.push(body.join("\n"));
    current = fenceLang === null ? [] : [`\`\`\`${fenceLang}`];
    length = current.reduce((n, l) => n + l.length + 1, 0);
  };

  for (const rawLine of lines) {
    // A single line longer than the budget still has to be broken somewhere.
    const pieces =
      rawLine.length <= max
        ? [rawLine]
        : (rawLine.match(new RegExp(`.{1,${max}}`, "g")) ?? [rawLine]);

    for (const line of pieces) {
      if (length + line.length + 1 > max) flush();
      current.push(line);
      length += line.length + 1;

      const fence = FENCE.exec(line);
      if (fence) fenceLang = fenceLang === null ? (fence[1] ?? "") : null;
    }
  }

  if (current.length > 0 && current.join("").trim() !== "```") {
    chunks.push(fenceLang === null ? current.join("\n") : [...current, "```"].join("\n"));
  }
  return chunks.filter((c) => c.trim() !== "");
}

export interface DiscordAdapterOptions {
  /** Bot token, resolved from the secrets registry by the harness. */
  token: string;
  /**
   * The owner's Discord id, so a message addressed to "owner" has somewhere to
   * go without the caller knowing who that is.
   */
  ownerId?: string;
}

/**
 * Discord channel adapter. DMs become turns with live presence (reaction +
 * editable status embed). Approvals use embeds + native buttons.
 *
 * Discord is a public surface: anyone can DM the bot or click a button on a
 * prompt they can see. The adapter asks the injected authorizer (backed by the
 * identity mapping) before it touches anything, so it enforces the gate without
 * knowing who the owner is.
 */
/** Bytes per attachment, matching what the dashboard accepts. */
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/**
 * Download what came with a Discord message.
 *
 * A photo of a receipt is an ordinary way to tell KOS something, so dropping
 * attachments meant half of what the owner sent went unseen. Only what the
 * model can actually use is fetched: images and text. Anything else is named
 * in the reply rather than silently ignored, because "I do not see an image"
 * is a much worse answer than "I cannot read a .zip".
 */
export async function collectAttachments(
  message: Message,
): Promise<{ attachments: Attachment[]; skipped: string[] }> {
  const attachments: Attachment[] = [];
  const skipped: string[] = [];

  // A message with nothing attached is the common case, and a message shape
  // without the collection at all must not take the whole inbound path down
  // with it: dropping the text of what someone said is worse than dropping a file.
  const files = message.attachments?.values?.() ?? [];
  for (const file of files) {
    const name = file.name;
    const mediaType = file.contentType ?? "";
    if (file.size > MAX_ATTACHMENT_BYTES) {
      skipped.push(`${name} (too large)`);
      continue;
    }
    if (!isImage(mediaType) && !isTextual(mediaType, name)) {
      skipped.push(`${name} (${mediaType || "unknown type"})`);
      continue;
    }
    try {
      const res = await fetch(file.url);
      if (!res.ok) {
        skipped.push(`${name} (could not fetch)`);
        continue;
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      // Checked again after the fact: the size Discord reported is not the
      // size that arrived, and the cap exists to bound what is sent to a model.
      if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        skipped.push(`${name} (too large)`);
        continue;
      }
      attachments.push({
        name,
        mediaType: mediaType || "application/octet-stream",
        data: bytes.toString("base64"),
      });
    } catch {
      skipped.push(`${name} (could not fetch)`);
    }
  }

  return { attachments, skipped };
}

const STYLES: Record<string, ButtonStyle> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};

/** Discord's own limits, applied here so a long field is trimmed not refused. */
const CARD_TITLE_MAX = 256;
const CARD_BODY_MAX = 4096;
const FIELD_NAME_MAX = 256;
const FIELD_VALUE_MAX = 1024;
const FIELDS_MAX = 25;
const BUTTONS_PER_ROW = 5;
const ROWS_MAX = 5;

/** Turn a neutral card into a Discord embed. */
export function buildCard(card: MessageCard): EmbedBuilder {
  const embed = new EmbedBuilder();
  if (card.title) embed.setTitle(card.title.slice(0, CARD_TITLE_MAX));
  if (card.body) embed.setDescription(card.body.slice(0, CARD_BODY_MAX));
  if (card.url) embed.setURL(card.url);
  if (typeof card.color === "number") embed.setColor(card.color);
  if (card.footer) embed.setFooter({ text: card.footer.slice(0, CARD_TITLE_MAX) });
  if (card.imageUrl) embed.setImage(card.imageUrl);
  if (card.thumbnailUrl) embed.setThumbnail(card.thumbnailUrl);
  const fields = (card.fields ?? []).slice(0, FIELDS_MAX).map((f) => ({
    name: f.name.slice(0, FIELD_NAME_MAX) || "\u200b",
    value: f.value.slice(0, FIELD_VALUE_MAX) || "\u200b",
    ...(f.inline ? { inline: true } : {}),
  }));
  if (fields.length) embed.addFields(fields);
  return embed;
}

/**
 * Turn neutral buttons into rows.
 *
 * A button with a url is a link and never comes back; one with an id is a
 * press, and its custom id is the token the runtime handed out. Anything past
 * what Discord will show is dropped rather than making the whole message fail.
 */
export function buildButtons(
  buttons: MessageButton[],
): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  const usable = buttons.slice(0, BUTTONS_PER_ROW * ROWS_MAX);
  for (let i = 0; i < usable.length; i += BUTTONS_PER_ROW) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const button of usable.slice(i, i + BUTTONS_PER_ROW)) {
      const built = new ButtonBuilder().setLabel(button.label.slice(0, 80));
      if (button.url) {
        built.setStyle(ButtonStyle.Link).setURL(button.url);
      } else {
        built
          .setStyle(STYLES[button.style ?? "secondary"] ?? ButtonStyle.Secondary)
          .setCustomId(`${PRESS_PREFIX}${button.token ?? ""}`);
      }
      row.addComponents(built);
    }
    rows.push(row);
  }
  return rows;
}

export class DiscordAdapter implements ChannelAdapter {
  readonly name = "discord";
  private readonly client: Client;
  private readonly token: string;
  private messageHandler?: MessageHandler;
  private approvalHandler?: ApprovalHandler;
  private buttonHandler?: ButtonPressHandler;
  private readonly ownerId?: string;
  private isAuthorized: SenderAuthorizer = () => true;

  setAuthorizer(isAuthorized: SenderAuthorizer): void {
    this.isAuthorized = isAuthorized;
  }

  constructor(options: DiscordAdapterOptions) {
    this.token = options.token;
    if (options.ownerId) this.ownerId = options.ownerId;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction],
    });
  }

  async start(): Promise<void> {
    this.client.on(Events.MessageCreate, (message: Message) => {
      void this.receiveMessage(message);
    });

    this.client.on(Events.InteractionCreate, (interaction: Interaction) => {
      void this.receiveInteraction(interaction);
    });

    await this.client.login(this.token);
  }

  /** Gateway MessageCreate handler. Internal; separated for tests. */
  async receiveMessage(message: Message): Promise<void> {
    if (message.author.bot) return;
    // Only DMs for now (personal agent).
    if (message.guild) return;
    if (!this.isAuthorized(message.author.id)) {
      // Log for the owner, stay silent to the sender.
      console.warn(`[discord] ignored DM from unknown sender ${message.author.id}`);
      return;
    }
    const { attachments, skipped } = await collectAttachments(message);
    // A file KOS cannot read is said out loud rather than dropped, so the
    // owner is not left asking about a picture it was never shown.
    const note = skipped.length
      ? `\n\n(not read: ${skipped.join(", ")})`
      : "";

    await this.messageHandler?.({
      channel: this.name,
      senderId: message.author.id,
      text: message.content + note,
      ...(attachments.length ? { attachments } : {}),
      native: message,
    });
  }

  /** Gateway InteractionCreate handler. Internal; separated for tests. */
  async receiveInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isButton()) return;

    // A button the agent put on a message of its own, rather than one the risk
    // gate put on an approval prompt.
    if (interaction.customId.startsWith(PRESS_PREFIX)) {
      const token = interaction.customId.slice(PRESS_PREFIX.length);
      if (!this.isAuthorized(interaction.user.id)) {
        try {
          await interaction.reply({
            content: "Not authorized.",
            flags: MessageFlags.Ephemeral,
          });
        } catch {
          // interaction may already be acknowledged
        }
        return;
      }
      // The component type is a union and only some members carry a label;
      // reading it defensively is cheaper than narrowing a wire shape.
      const label =
        (interaction.component as { label?: string | null }).label ?? "";
      try {
        // Acknowledged without changing the message: the buttons stay usable,
        // because a press is a message to KOS rather than a decision that
        // consumes the thing it was on.
        await interaction.deferUpdate();
      } catch {
        // interaction may already be acknowledged
      }
      await this.buttonHandler?.({
        buttonId: "",
        label,
        token,
        pressedBy: interaction.user.id,
      });
      return;
    }

    const decision = parseApprovalCustomId(interaction.customId);
    if (!decision) return;

    if (!this.isAuthorized(interaction.user.id)) {
      // Leave the prompt intact (still approvable by the owner) and say nothing
      // about the action behind it.
      console.warn(
        `[discord] ignored approval click on #${decision.id} from unknown sender ${interaction.user.id}`,
      );
      try {
        await interaction.reply({
          content: "Not authorized.",
          flags: MessageFlags.Ephemeral,
        });
      } catch {
        // interaction may already be acknowledged
      }
      return;
    }

    try {
      await interaction.update({
        content: decision.approved ? "Working on that…" : "Denied.",
        embeds: decision.approved
          ? [
              new EmbedBuilder()
                .setColor(COLOR_WORKING)
                .setTitle("Approved")
                .setDescription(`Running pending \`#${decision.id}\`…`),
            ]
          : [],
        components: [],
      });
    } catch {
      // interaction may already be acknowledged
    }
    await this.approvalHandler?.({
      id: decision.id,
      approved: decision.approved,
      deciderId: interaction.user.id,
    });
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  onApproval(handler: ApprovalHandler): void {
    this.approvalHandler = handler;
  }

  onButton(handler: ButtonPressHandler): void {
    this.buttonHandler = handler;
  }

  async send(recipientId: string, msg: OutboundMessage): Promise<void> {
    const user = await this.client.users.fetch(recipientId);
    await this.deliver((payload) => user.send(payload), msg);
  }

  /**
   * Send somewhere other than the owner's DM.
   *
   * A bot that can only DM one person is not much of a bot on a server, and
   * the surface already has the notion of a place to post in. Owner still
   * means the DM, so the ordinary path is unchanged.
   */
  async sendTo(target: MessageTarget, msg: OutboundMessage): Promise<void> {
    if (target.kind === "channel") {
      const channel = await this.client.channels.fetch(target.id);
      if (!channel || !channel.isSendable()) {
        throw new Error(
          `discord channel ${target.id} is not somewhere this bot can post`,
        );
      }
      await this.deliver((payload) => channel.send(payload), msg);
      return;
    }
    const id = target.kind === "user" ? target.id : this.ownerId;
    if (!id) throw new Error("no owner is configured to send to");
    await this.send(id, msg);
  }

  /**
   * One place that turns a neutral message into what Discord takes.
   *
   * The text is chunked because Discord refuses anything over 2000 characters,
   * and the card and the buttons ride on the last chunk so they end up under
   * the whole message rather than in the middle of it.
   */
  private async deliver(
    post: (payload: {
      content?: string;
      embeds?: EmbedBuilder[];
      components?: ActionRowBuilder<ButtonBuilder>[];
    }) => Promise<unknown>,
    msg: OutboundMessage,
  ): Promise<void> {
    const chunks = msg.text ? chunkText(msg.text) : [];
    const embeds = msg.card ? [buildCard(msg.card)] : [];
    const components = buildButtons(msg.buttons ?? []);
    if (chunks.length === 0 && embeds.length === 0) {
      throw new Error("nothing to send: no text and no card");
    }
    for (let i = 0; i < Math.max(chunks.length, 1); i++) {
      const last = i === Math.max(chunks.length, 1) - 1;
      await post({
        ...(chunks[i] ? { content: chunks[i] } : {}),
        ...(last && embeds.length ? { embeds } : {}),
        ...(last && components.length ? { components } : {}),
      });
    }
  }

  /**
   * React ⏳ on the user message, post a status embed, then edit it to the
   * final reply (and swap reaction to ✅ / ❌).
   */
  async acknowledge(msg: InboundMessage): Promise<TurnPresence | undefined> {
    const inbound = msg.native;
    if (!inbound || typeof inbound !== "object") return undefined;
    const message = inbound as Message;

    try {
      await message.react(REACT_WORKING);
    } catch {
      // reactions may fail in some DM configs
    }

    let statusMsg: Message;
    try {
      statusMsg = await message.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(COLOR_WORKING)
            .setTitle("KOS")
            .setDescription("Working on it…")
            .setFooter({ text: "you can keep talking; turns run one at a time" }),
        ],
      });
    } catch {
      // fall back to plain send path
      return undefined;
    }

    const swapReact = async (from: string, to: string): Promise<void> => {
      try {
        await message.reactions.cache.get(from)?.users.remove(this.client.user!.id);
      } catch {
        // ignore
      }
      try {
        await message.react(to);
      } catch {
        // ignore
      }
    };

    return {
      update: async (status: string) => {
        try {
          await statusMsg.edit({
            embeds: [
              new EmbedBuilder()
                .setColor(COLOR_WORKING)
                .setTitle("KOS")
                .setDescription(status.slice(0, 4000)),
            ],
          });
        } catch {
          // ignore edit races
        }
      },
      complete: async (reply: OutboundMessage) => {
        await swapReact(REACT_WORKING, REACT_DONE);
        // The reply lands as ordinary message content, not an embed, so the
        // model owns the presentation: headings, lists, code blocks and the
        // rest render as written instead of being flattened into one
        // description field under a fixed title. A turn that chose a card
        // gets it under the text, on the last chunk, where a reader arrives
        // at it having read the answer.
        const chunks = reply.text ? chunkText(reply.text) : [];
        const embeds = reply.card ? [buildCard(reply.card)] : [];
        const components = buildButtons(reply.buttons ?? []);
        const last = Math.max(chunks.length, 1) - 1;
        try {
          await statusMsg.edit({
            content: chunks[0] ?? "",
            embeds: last === 0 ? embeds : [],
            components: last === 0 ? components : [],
          });
          for (let i = 1; i < chunks.length; i++) {
            await this.send(msg.senderId, {
              text: chunks[i]!,
              ...(i === last && reply.card ? { card: reply.card } : {}),
              ...(i === last && reply.buttons ? { buttons: reply.buttons } : {}),
            });
          }
        } catch {
          await this.send(msg.senderId, reply);
        }
      },
      fail: async (err: string) => {
        await swapReact(REACT_WORKING, REACT_FAIL);
        try {
          // Failures keep the embed: that is the harness speaking about a
          // broken turn, not the agent presenting work.
          await statusMsg.edit({
            content: "",
            embeds: [
              new EmbedBuilder()
                .setColor(COLOR_FAIL)
                .setTitle("KOS")
                .setDescription(err.slice(0, 4000)),
            ],
          });
        } catch {
          await this.send(msg.senderId, { text: err });
        }
      },
    };
  }

  async requestApproval(
    recipientId: string,
    req: ApprovalRequest,
  ): Promise<void> {
    const ids = approvalCustomIds(req.id);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(ids.approve)
        .setLabel("Approve")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(ids.deny)
        .setLabel("Deny")
        .setStyle(ButtonStyle.Danger),
    );

    const tool = req.tool ?? "action";
    const args = req.args ?? {};
    const summary = summarizeAction(tool, args);
    const body =
      req.tool !== undefined
        ? formatApprovalPrompt(req.id, tool, args, req.reason)
        : req.text;

    const embed = new EmbedBuilder()
      .setColor(COLOR_APPROVE)
      .setTitle("Approval needed")
      .setDescription(summary)
      .addFields(
        { name: "Tool", value: `\`${tool}\``, inline: true },
        { name: "Pending", value: `\`#${req.id}\``, inline: true },
      )
      .setFooter({ text: "KOS · risk gate" });

    if (req.reason) {
      embed.addFields({ name: "Reason", value: req.reason.slice(0, 200) });
    }

    // Keep a short plain-text fallback for clients that hide embeds.
    const user = await this.client.users.fetch(recipientId);
    await user.send({
      content: body.split("\n")[0],
      embeds: [embed],
      components: [row],
    });
  }
}
