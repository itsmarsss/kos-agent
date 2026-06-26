import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Interaction,
  type Message,
} from "discord.js";

import type {
  ApprovalHandler,
  ApprovalRequest,
  ChannelAdapter,
  MessageHandler,
  OutboundMessage,
} from "./types.js";

export const APPROVE_PREFIX = "kos:approve:";
export const DENY_PREFIX = "kos:deny:";

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

export interface DiscordAdapterOptions {
  /** Bot token, resolved from the secrets registry by the harness. */
  token: string;
}

/**
 * Discord channel adapter. Receives direct messages, replies via DM, and
 * renders approval prompts as native approve/deny buttons that map to the
 * approval queue. The bot never sees secrets beyond its own token.
 */
export class DiscordAdapter implements ChannelAdapter {
  readonly name = "discord";
  private readonly client: Client;
  private readonly token: string;
  private messageHandler?: MessageHandler;
  private approvalHandler?: ApprovalHandler;

  constructor(options: DiscordAdapterOptions) {
    this.token = options.token;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
  }

  async start(): Promise<void> {
    this.client.on(Events.MessageCreate, (message: Message) => {
      if (message.author.bot) return;
      void this.messageHandler?.({
        channel: this.name,
        senderId: message.author.id,
        text: message.content,
      });
    });

    this.client.on(Events.InteractionCreate, (interaction: Interaction) => {
      if (!interaction.isButton()) return;
      const decision = parseApprovalCustomId(interaction.customId);
      if (!decision) return;
      void this.approvalHandler?.({
        id: decision.id,
        approved: decision.approved,
        deciderId: interaction.user.id,
      });
      void interaction.update({
        content: decision.approved ? "Approved." : "Denied.",
        components: [],
      });
    });

    await this.client.login(this.token);
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

  async send(recipientId: string, msg: OutboundMessage): Promise<void> {
    const user = await this.client.users.fetch(recipientId);
    await user.send(msg.text);
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
    const user = await this.client.users.fetch(recipientId);
    await user.send({ content: req.text, components: [row] });
  }
}
