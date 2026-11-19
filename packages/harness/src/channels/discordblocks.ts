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
export const EMBEDS_MAX = 10;
export const ROWS_MAX = 5;
/** Discord refuses a message whose embeds add up past 6000 characters; a little is kept spare. */
export const EMBED_TOTAL_MAX = 5_800;
/** The longest address a link button takes. */
const LINK_URL_MAX = 512;

/** Whether Discord takes an address as a link button's. */
export function linkFits(url: string): boolean {
  return url.length <= LINK_URL_MAX && /^https?:\/\/\S+$/i.test(url);
}

/** An embed's size as Discord counts it against a message's total. */
export function embedLength(embed: EmbedBuilder): number {
  const e = embed.toJSON();
  const fields = (e.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);
  return (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.footer?.text.length ?? 0) + (e.author?.name.length ?? 0) + fields;
}

/**
 * A message's words with its typed blocks taken out, and the blocks, in
 * order. `fits` is asked of each block in turn and says whether it still
 * fits on the message; once one does not, it and every block after it stay
 * as their plain words, so an answer is never refused for its blocks.
 */
export function splitBlocks(text: string, fits: (block: KosBlock) => boolean = () => true): { words: string; blocks: KosBlock[] } {
  const blocks: KosBlock[] = [];
  let full = false;
  const words = replaceBlocks(text, (block) => {
    full ||= blocks.length >= BLOCKS_PER_MESSAGE || !fits(block);
    if (full) return plainOf(block);
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
  for (const l of view.links.filter((l) => linkFits(l.href)).slice(0, 3)) row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(l.href).setLabel(`${l.label} (${l.host})`.slice(0, 80)));
  return row;
}

/** The longest draft Copy answers with in a code block; a longer one comes as a file, whole. */
const COPY_INLINE_MAX = 1_980;

/** What Copy answers with: the text in a code block, or as a file when a message cannot hold it. */
export function copyReply(block: KosBlock): { content: string; files?: { attachment: Buffer; name: string }[] } {
  const text = copyOf(block);
  if (text.length > COPY_INLINE_MAX) return { content: "-# The whole draft, as a file.", files: [{ attachment: Buffer.from(text, "utf8"), name: "draft.txt" }] };
  return { content: `\`\`\`\n${text.replace(/```/g, "'''")}\n\`\`\`` };
}

/** The tool a block's Send would use, when it has one. */
export function sendTool(block: KosBlock, tools: readonly string[]): string | undefined {
  return viewOf(block).kind.actions.includes("send") ? sendToolOf(block, tools) : undefined;
}
