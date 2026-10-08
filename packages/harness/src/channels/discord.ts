import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  Partials,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Interaction,
  type Message,
  type ModalSubmitInteraction,
} from "discord.js";
import { detailLines, summarizeAction } from "@kos/shared";

import { isImage, isTextual, type Attachment } from "../kernel/attachments.js";
import { COMMANDS, completions, runCommand, type SlashContext } from "./commands.js";
import { MESSAGE_LIMITS } from "./types.js";
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
  ModalSpec,
  OutboundMessage,
  PressResponder,
  SenderAuthorizer,
  TurnPresence,
} from "./types.js";

export const APPROVE_PREFIX = "kos:approve:";
export const DENY_PREFIX = "kos:deny:";
/** Approve, and remember this shape so it stops asking. */
export const ALWAYS_PREFIX = "kos:always:";
/** A button the agent put there, as opposed to one the risk gate did. */
export const PRESS_PREFIX = "kos:press:";
/** The form a press opened, named for the button it came from. */
export const MODAL_PREFIX = "kos:form:";
/** How long a form is left open before the interaction is let go. */
const MODAL_WAIT_MS = 5 * 60 * 1000;

const REACT_WORKING = "⏳";
const REACT_DONE = "✅";
const REACT_FAIL = "❌";
/** Subtext lines may not be longer than this and still read as a glance. */
const DETAIL_MAX = 160;

/**
 * The text of an approval prompt: what, then the small print.
 *
 * Two lines and the buttons. The embed this replaced had a title, a
 * description, three labelled fields, a footer and a plain-text copy of
 * the same above it; the owner read it as a form. The first line is the
 * action as summarizeAction says it; the subtext carries the tool, the id,
 * the arguments that matter and the reason, and renders small and grey.
 */
export function approvalText(req: ApprovalRequest): string {
  if (req.tool === undefined) {
    return [`**Needs your OK** · ${req.text}`, `-# #${req.id}${req.reason ? ` · ${req.reason}` : ""}`].join("\n");
  }
  const args = req.args ?? {};
  const details = detailLines(req.tool, args)
    .slice(1)
    .filter((l) => !l.startsWith("…"))
    .slice(0, 3)
    .map((l) => (l.length > DETAIL_MAX ? `${l.slice(0, DETAIL_MAX - 1)}…` : l));
  const small = [`${req.tool} · #${req.id}`, ...details, ...(req.reason ? [req.reason] : [])].join(" · ");
  return [`**Needs your OK** · ${summarizeAction(req.tool, args)}`, `-# ${small}`].join("\n");
}

/** What a settled prompt becomes: one small line saying how it went. */
export function settledText(outcome: "approved" | "denied", summary: string | undefined, id: string): string {
  const mark = outcome === "approved" ? "✅ Approved" : "❌ Denied";
  return `-# ${mark} · ${summary ?? `#${id}`}`;
}

/** Encode the approve/deny button ids for a pending action. */
export function approvalCustomIds(pendingId: string): {
  approve: string;
  deny: string;
  always: string;
} {
  return {
    approve: `${APPROVE_PREFIX}${pendingId}`,
    deny: `${DENY_PREFIX}${pendingId}`,
    always: `${ALWAYS_PREFIX}${pendingId}`,
  };
}

/** Decode a button customId back into an approval decision, or null. */
export function parseApprovalCustomId(
  customId: string,
): { id: string; approved: boolean; remember?: boolean } | null {
  if (customId.startsWith(ALWAYS_PREFIX)) {
    return { id: customId.slice(ALWAYS_PREFIX.length), approved: true, remember: true };
  }
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
const BUTTONS_PER_ROW = 5;
/** The shared contract, so the tool and the adapter cannot drift apart. */
const FIELDS_MAX = MESSAGE_LIMITS.cardFields;
const BUTTONS_MAX = MESSAGE_LIMITS.buttons;
const MODAL_FIELDS_MAX = MESSAGE_LIMITS.modalFields;

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
  const usable = buttons.slice(0, BUTTONS_MAX);
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

/** Turn a neutral form into what Discord shows. */
export function buildModal(customId: string, modal: ModalSpec): ModalBuilder {
  const built = new ModalBuilder()
    .setCustomId(customId)
    .setTitle(modal.title.slice(0, 45));
  // Five is what the surface allows; the rest are dropped rather than making
  // the whole form fail to open.
  for (const field of modal.fields.slice(0, MODAL_FIELDS_MAX)) {
    const input = new TextInputBuilder()
      .setCustomId(field.id)
      .setLabel(field.label.slice(0, 45))
      .setStyle(
        field.style === "paragraph" ? TextInputStyle.Paragraph : TextInputStyle.Short,
      )
      .setRequired(field.required !== false);
    if (field.placeholder) input.setPlaceholder(field.placeholder.slice(0, 100));
    if (field.value) input.setValue(field.value);
    if (field.maxLength) input.setMaxLength(field.maxLength);
    built.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(input),
    );
  }
  return built;
}

export class DiscordAdapter implements ChannelAdapter {
  readonly name = "discord";
  private readonly client: Client;
  private readonly token: string;
  private messageHandler?: MessageHandler;
  private approvalHandler?: ApprovalHandler;
  private buttonHandler?: ButtonPressHandler;
  /**
   * Prompts still offering a choice, by pending id.
   *
   * In memory rather than stored: a prompt outlives the process only in the
   * sense that the message is still there, and a restart losing the handle
   * costs a stale prompt rather than a wrong decision -- pressing it answers
   * that the action does not exist, which is true.
   */
  private readonly prompts = new Map<string, { message: Message; summary: string }>();
  private commands?: SlashContext;
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
    /*
     * A gateway error is a log line, not the end of the host.
     *
     * The host once died at 9am from "Opening handshake has timed out": the
     * laptop had slept, the socket to Discord went stale, and the error it
     * raised while reconnecting had nothing listening for it. An unheard
     * error event brings the process down. discord.js reconnects on its own
     * once the socket closes; all it needs from here is someone listening.
     */
    this.client.on(Events.Error, (err: Error) => {
      console.error(`Discord: ${err.message}`);
    });
    this.client.on(Events.ShardError, (err: Error) => {
      console.error(`Discord gateway: ${err.message}`);
    });
  }

  /** Told what the slash commands do, when the harness wires them. */
  onCommand(ctx: SlashContext): void {
    this.commands = ctx;
  }

  async start(): Promise<void> {
    this.client.on(Events.MessageCreate, (message: Message) => {
      void this.receiveMessage(message);
    });

    /*
     * Registered once the connection is up, because it needs the bot's own
     * id. Global rather than per guild: KOS is talked to in a DM, and a DM
     * has no guild to register against.
     */
    this.client.once(Events.ClientReady, () => {
      void this.registerCommands();
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

  /**
   * Publish the command list to Discord.
   *
   * Overwrites rather than merges, so a command removed from COMMANDS stops
   * being offered instead of lingering as something that answers "no such
   * command".
   */
  private async registerCommands(): Promise<void> {
    if (!this.commands) return;
    try {
      await this.client.application?.commands.set(
        COMMANDS.map((c) => ({
          name: c.name,
          description: c.description,
          ...(c.argument
            ? {
                options: [
                  {
                    type: 3,
                    name: c.argument.name,
                    description: c.argument.description,
                    required: false,
                    autocomplete: c.argument.autocomplete,
                  },
                ],
              }
            : {}),
        })),
      );
    } catch (err) {
      // A bot without the applications.commands scope cannot register them.
      // Everything else still works, so this is reported rather than fatal.
      console.warn(
        `[discord] could not register slash commands: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Gateway InteractionCreate handler. Internal; separated for tests. */
  async receiveInteraction(interaction: Interaction): Promise<void> {
    /*
     * Slash commands are answered here and never reach the model: they are
     * bookkeeping the process already knows the answer to, and a turn would
     * spend tokens and seconds to say where messages are going.
     */
    if (interaction.isAutocomplete?.()) {
      if (!this.commands || !this.isAuthorized(interaction.user.id)) return;
      const typed = String(interaction.options.getFocused() ?? "");
      try {
        await interaction.respond(completions(this.commands, typed));
      } catch {
        // The window for answering an autocomplete is short; a late answer
        // is dropped rather than being an error.
      }
      return;
    }

    if (interaction.isChatInputCommand?.()) {
      if (!this.commands) return;
      if (!this.isAuthorized(interaction.user.id)) {
        await interaction.reply({
          content: "Not authorized.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const argument = interaction.options.data[0]?.value;
      const said = runCommand(
        this.commands,
        interaction.commandName,
        argument === undefined ? undefined : String(argument),
      );
      // Only to whoever asked: where someone sends their messages is not
      // news for a channel.
      await interaction.reply({
        ...(said.text ? { content: said.text } : {}),
        ...(said.card ? { embeds: [buildCard(said.card)] } : {}),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

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
      await this.handlePress(interaction, token, label);
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
      // The prompt settles into one small line; the resumed turn's answer is
      // its own message, which is the one the owner is waiting for.
      await interaction.update({
        content: settledText(decision.approved ? "approved" : "denied", this.prompts.get(decision.id)?.summary, decision.id),
        embeds: [],
        components: [],
      });
    } catch {
      // interaction may already be acknowledged
    }
    this.prompts.delete(decision.id);
    await this.approvalHandler?.({
      id: decision.id,
      approved: decision.approved,
      deciderId: interaction.user.id,
      ...(decision.remember ? { remember: true } : {}),
    });
  }

  /**
   * A press, from the moment it lands to the answer the presser reads.
   *
   * Discord holds the presser on a spinner and will not hold one for long: an
   * acknowledgement is due in about three seconds and the real answer within
   * fifteen minutes. A turn takes as long as it takes, so the order matters
   * and it is the handler that decides it -- ask for the form first, because
   * a form cannot be shown once the interaction has been acknowledged any
   * other way; then say the work has started; then say the thing.
   */
  private async handlePress(
    interaction: ButtonInteraction,
    token: string,
    label: string,
  ): Promise<void> {
    // Where the answer goes once a form has moved the conversation onto the
    // submission: the button's own interaction can no longer be replied to.
    let live: ButtonInteraction | ModalSubmitInteraction = interaction;
    let acknowledged = false;
    // Settled at the acknowledgement and remembered, because every follow-up
    // has to carry the same flag: a private answer with a public card under
    // it is not a private answer.
    let ephemeral = false;

    const payloadFor = (msg: OutboundMessage): {
      content?: string;
      embeds?: EmbedBuilder[];
      components?: ActionRowBuilder<ButtonBuilder>[];
    } => ({
      ...(msg.text ? { content: msg.text.slice(0, 2000) } : {}),
      ...(msg.card ? { embeds: [buildCard(msg.card)] } : {}),
      ...(msg.buttons?.length ? { components: buildButtons(msg.buttons) } : {}),
    });

    const respond: PressResponder = {
      openForm: async (modal) => {
        const formId = `${MODAL_PREFIX}${token}`;
        await interaction.showModal(buildModal(formId, modal));
        try {
          const submitted = await interaction.awaitModalSubmit({
            time: MODAL_WAIT_MS,
            filter: (i) =>
              i.customId === formId && i.user.id === interaction.user.id,
          });
          live = submitted;
          const values: Record<string, string> = {};
          for (const field of modal.fields) {
            values[field.id] = submitted.fields.getTextInputValue(field.id);
          }
          return values;
        } catch {
          // Closed, or left open past the window. Not an error: the reader
          // decided not to answer, and there is nothing to report.
          return undefined;
        }
      },

      working: async (opts) => {
        if (acknowledged) return;
        acknowledged = true;
        ephemeral = opts?.ephemeral === true;
        try {
          // deferReply rather than deferUpdate: the answer is a new message,
          // so the message the button sits on keeps its buttons and stays
          // pressable.
          await live.deferReply({
            ...(opts?.ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
          });
        } catch {
          // already acknowledged by something else
        }
      },

      followUp: async (msg) => {
        // Only after an acknowledgement, which working() has already made by
        // the time a turn is running.
        if (!acknowledged) await respond.working();
        try {
          await live.followUp({
            ...payloadFor(msg),
            ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
          });
        } catch {
          await this.send(interaction.user.id, msg);
        }
      },

      send: async (msg) => {
        const payload = payloadFor(msg);
        if (!payload.content && !payload.embeds) payload.content = "(no reply)";
        try {
          if (acknowledged) {
            await live.editReply(payload);
            return;
          }
          await live.reply(payload);
          acknowledged = true;
        } catch {
          // Past the window the interaction is gone, so the answer goes where
          // the reader can still find it rather than nowhere.
          await this.send(interaction.user.id, msg);
        }
      },
    };

    if (!this.buttonHandler) {
      try {
        await interaction.deferUpdate();
      } catch {
        // nothing is listening; the press is simply dropped
      }
      return;
    }

    await this.buttonHandler(
      { buttonId: "", label, token, pressedBy: interaction.user.id },
      respond,
    );

    // A handler that said nothing still has to release the spinner.
    if (!acknowledged) {
      try {
        await interaction.deferUpdate();
      } catch {
        // already acknowledged
      }
    }
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
      if (!target.id) throw new Error("a channel needs an id");
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
   * The ⏳ reaction is the whole presence; the answer is a message of its own.
   *
   * This used to post a "Working on it…" embed and edit it into the reply.
   * The owner's phone buzzed for the placeholder, the reply itself (an edit)
   * never notified, and a titled box with a footer sat under every question.
   * A reaction says the same thing in no space at all, and the reply then
   * arrives as the notification, carrying its own content.
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

    // Into the same DM the question came from, without quoting it: a
    // reply reference adds a "replying to" line to every answer.
    const channel = message.channel as { send?: (payload: unknown) => Promise<unknown> } | undefined;
    const post = async (payload: unknown): Promise<void> => {
      if (!channel?.send) throw new Error("no channel to answer in");
      await channel.send(payload);
    };

    return {
      // Nothing to edit: the reaction says the turn is running.
      update: async () => undefined,
      complete: async (reply: OutboundMessage) => {
        await swapReact(REACT_WORKING, REACT_DONE);
        try {
          await this.deliver(post, reply);
        } catch {
          await this.send(msg.senderId, reply);
        }
      },
      fail: async (err: string) => {
        await swapReact(REACT_WORKING, REACT_FAIL);
        const text = `❌ ${err.slice(0, 1900)}`;
        try {
          await post({ content: text });
        } catch {
          await this.send(msg.senderId, { text });
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
        .setCustomId(ids.always)
        .setLabel("Always")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(ids.deny)
        .setLabel("Deny")
        .setStyle(ButtonStyle.Danger),
    );

    const summary = req.tool !== undefined ? summarizeAction(req.tool, req.args ?? {}) : req.text;
    const user = await this.client.users.fetch(recipientId);
    const sent = await user.send({
      content: approvalText(req),
      components: [row],
    });
    this.prompts.set(req.id, { message: sent, summary });
  }

  /**
   * Settle a prompt whose decision came from somewhere else.
   *
   * The same edit the buttons make when pressed here, so a decision looks the
   * same wherever it was made.
   */
  async settleApproval(id: string, outcome: "approved" | "denied"): Promise<void> {
    const prompt = this.prompts.get(id);
    if (!prompt) return;
    this.prompts.delete(id);
    try {
      await prompt.message.edit({
        content: settledText(outcome, prompt.summary, id),
        embeds: [],
        components: [],
      });
    } catch {
      // Deleted, or too old to edit. A prompt that cannot be settled is not
      // worth failing a decision over.
    }
  }
}
