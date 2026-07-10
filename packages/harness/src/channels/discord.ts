import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Partials,
  type Interaction,
  type Message,
} from "discord.js";
import {
  formatApprovalPrompt,
  summarizeAction,
} from "@kos/shared";

import type {
  ApprovalHandler,
  ApprovalRequest,
  ChannelAdapter,
  InboundMessage,
  MessageHandler,
  OutboundMessage,
  TurnPresence,
} from "./types.js";

export const APPROVE_PREFIX = "kos:approve:";
export const DENY_PREFIX = "kos:deny:";

const REACT_WORKING = "⏳";
const REACT_DONE = "✅";
const REACT_FAIL = "❌";
const COLOR_WORKING = 0x6366f1;
const COLOR_OK = 0x22c55e;
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

/** Split long replies so Discord's 2000-char / embed limits are respected. */
export function chunkText(text: string, max = 1900): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export interface DiscordAdapterOptions {
  /** Bot token, resolved from the secrets registry by the harness. */
  token: string;
}

/**
 * Discord channel adapter. DMs become turns with live presence (reaction +
 * editable status embed). Approvals use embeds + native buttons.
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
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction],
    });
  }

  async start(): Promise<void> {
    this.client.on(Events.MessageCreate, (message: Message) => {
      if (message.author.bot) return;
      // Only DMs for now (personal agent).
      if (message.guild) return;
      void this.messageHandler?.({
        channel: this.name,
        senderId: message.author.id,
        text: message.content,
        native: message,
      });
    });

    this.client.on(Events.InteractionCreate, (interaction: Interaction) => {
      if (!interaction.isButton()) return;
      const decision = parseApprovalCustomId(interaction.customId);
      if (!decision) return;
      void (async () => {
        try {
          await interaction.update({
            content: decision.approved
              ? "Working on that…"
              : "Denied.",
            embeds: decision.approved
              ? [
                  new EmbedBuilder()
                    .setColor(COLOR_WORKING)
                    .setTitle(decision.approved ? "Approved" : "Denied")
                    .setDescription(
                      decision.approved
                        ? `Running pending \`#${decision.id}\`…`
                        : `Pending \`#${decision.id}\` was denied.`,
                    ),
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
      })();
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
    const chunks = chunkText(msg.text);
    for (const chunk of chunks) {
      await user.send(chunk);
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
      complete: async (reply: string) => {
        await swapReact(REACT_WORKING, REACT_DONE);
        const chunks = chunkText(reply, 4000);
        try {
          await statusMsg.edit({
            embeds: [
              new EmbedBuilder()
                .setColor(COLOR_OK)
                .setTitle("KOS")
                .setDescription(chunks[0] || "(no reply)"),
            ],
          });
          // Overflow as plain follow-ups (embeds are size-capped).
          for (let i = 1; i < chunks.length; i++) {
            await this.send(msg.senderId, { text: chunks[i]! });
          }
        } catch {
          await this.send(msg.senderId, { text: reply });
        }
      },
      fail: async (err: string) => {
        await swapReact(REACT_WORKING, REACT_FAIL);
        try {
          await statusMsg.edit({
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
