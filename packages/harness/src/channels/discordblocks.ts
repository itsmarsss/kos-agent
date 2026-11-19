import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { checklistOf, copyOf, plainOf, replaceBlocks, sendToolOf, stepsOf, viewOf, type KosBlock } from "@kos/shared";

/**
 * A typed block on Discord: an embed with the block's fields laid out, its
 * body as the description, and its actions as buttons. Copy answers the
 * presser alone with the text as a code block; Send, where the kind has one
 * and this KOS has a tool for it, asks KOS to send the draft in the chat,
 * so the tool call is tiered and approved as any other.
 */

export const BLOCK_COPY_PREFIX = "kos:block:copy:";
export const BLOCK_SEND_PREFIX = "kos:block:send:";

const TITLE_MAX = 256;
const BODY_MAX = 4096;
const FIELD_VALUE_MAX = 1024;
/** Discord shows ten embeds on a message, five rows of buttons. */
export const BLOCKS_PER_MESSAGE = 5;

/** A message's words with its typed blocks taken out, and the blocks, in order. */
export function splitBlocks(text: string): { words: string; blocks: KosBlock[] } {
  const blocks: KosBlock[] = [];
  // Past what one message shows, a block stays as its plain words.
  const words = replaceBlocks(text, (block) => {
    if (blocks.length >= BLOCKS_PER_MESSAGE) return plainOf(block);
    blocks.push(block);
    return "";
  });
  return { words: blocks.length ? words.replace(/\n{3,}/g, "\n\n").trim() : text, blocks };
}

/** A body as Discord draws it, by the kind's style: code stays code, a list a list. */
function bodyOf(block: KosBlock, style: string): string {
  const body = block.body;
  if (!body) return "";
  const fence = (lang: string): string => `\`\`\`${lang}\n${body.replace(/```/g, "'''")}\n\`\`\``;
  switch (style) {
    case "mono":
      return fence("");
    case "diff":
      return fence("diff");
    case "checklist":
      return checklistOf(body)
        .map((item) => (item.done === undefined ? item.text : `${item.done ? "☑" : "☐"} ${item.text}`))
        .join("\n");
    case "steps":
      return stepsOf(body)
        .map((s, i) => `${i + 1}. ${s}`)
        .join("\n");
    case "quote":
      return body
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
    default:
      return body;
  }
}

/** The block as an embed: titled by its title or its kind, a field a row, the body below. */
export function blockEmbed(block: KosBlock, link: (text: string) => string = (t) => t): EmbedBuilder {
  const view = viewOf(block);
  const head = [view.kind.label, view.title].filter(Boolean).join(": ") || view.kind.plain || "Card";
  const embed = new EmbedBuilder().setTitle(head.slice(0, TITLE_MAX));
  const body = bodyOf(block, view.kind.body);
  if (body) embed.setDescription(link(body).slice(0, BODY_MAX));
  const fields = view.rows.slice(0, 20).map((r) => ({ name: r.label.slice(0, TITLE_MAX), value: link(r.values.join(", ")).slice(0, FIELD_VALUE_MAX) || "​", inline: r.values.join(", ").length <= 40 }));
  if (fields.length) embed.addFields(fields);
  return embed;
}

/**
 * The block's buttons: Copy, Send when the kind sends and a tool here can,
 * and a link for each `action: open` it carries, its host beside its words.
 */
export function blockButtons(key: string, block: KosBlock, tools: readonly string[], canSend: boolean): ActionRowBuilder<ButtonBuilder> {
  const view = viewOf(block);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`${BLOCK_COPY_PREFIX}${key}`).setLabel("Copy").setStyle(ButtonStyle.Secondary));
  const tool = canSend && view.kind.actions.includes("send") ? sendToolOf(block, tools) : undefined;
  if (tool) row.addComponents(new ButtonBuilder().setCustomId(`${BLOCK_SEND_PREFIX}${key}`).setLabel("Send").setStyle(ButtonStyle.Primary));
  for (const l of view.links.slice(0, 3)) row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(l.href).setLabel(`${l.label} (${l.host})`.slice(0, 80)));
  return row;
}

/** What Copy answers with: the text in a code block, cut to fit a message. */
export function copyReply(block: KosBlock): string {
  const text = copyOf(block).replace(/```/g, "'''");
  return `\`\`\`\n${text.length > 1980 ? `${text.slice(0, 1979)}…` : text}\n\`\`\``;
}

/** The tool a block's Send would use, when it has one. */
export function sendTool(block: KosBlock, tools: readonly string[]): string | undefined {
  return viewOf(block).kind.actions.includes("send") ? sendToolOf(block, tools) : undefined;
}
