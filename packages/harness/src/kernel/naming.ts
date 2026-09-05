import type { Inference } from "../agent/loop.js";
import { textOf } from "../models/types.js";

/**
 * What to call a conversation.
 *
 * A title was the owner's first message with the end cut off, so a list of
 * them is a list of half-sentences: "can you build a mini 3js shooter game
 * proj…", "anyways, for our book keep track app, can you…". Every place that
 * shows a chat by name inherits that -- the sidebar, the Discord picker, a
 * card saying where messages are going -- and none of it can be read at a
 * glance.
 *
 * A name is a few words for what the conversation is about, which is a thing
 * the cheap model can do in one call. Done once, when the conversation is
 * still carrying the message it was opened with.
 */

const SYSTEM = [
  "Name a conversation in two to four words, as a person would label a folder.",
  "Say what it is about, not what was asked: \"3js shooter game\", not \"build a game\".",
  "No punctuation at the end, no quotes, no articles at the start.",
  "Reply with the name and nothing else.",
].join("\n");

/** Longest a generated name may be before it is not a name any more. */
const MAX = 48;

/**
 * Does this title look like one nobody chose?
 *
 * A name the owner typed is short and ends where they stopped typing. One
 * derived from a first message is long, or ends in the ellipsis that says it
 * was cut. Judged rather than recorded so conversations that predate naming
 * get one the next time they are used, instead of staying half-sentences
 * forever.
 */
export function looksAutoTitled(title: string): boolean {
  return (
    title === "New conversation" || title.endsWith("…") || title.length > 32
  );
}

/**
 * Clean up whatever came back.
 *
 * A small model asked for four words sometimes answers with a sentence about
 * the four words. Taking the first line and dropping any wrapping keeps the
 * failure to "a slightly long name" rather than a paragraph in the sidebar.
 */
export function tidyName(raw: string): string | null {
  const first = raw.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const bare = first
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.。]+$/, "")
    .trim();
  if (!bare || bare.length > MAX) return null;
  // A refusal or a preamble is not a name.
  if (/^(sure|here|okay|ok|title|name)\b/i.test(bare)) return null;
  // Nor is a structure. A model given the wrong prompt answers in the shape
  // it was last asked for, and {"facts":[]} would otherwise have become the
  // label on a conversation.
  if (/[{}[\]"<>]/.test(bare)) return null;
  return bare;
}

/**
 * Ask for a name, and settle for the message if none comes.
 *
 * Never throws: a conversation with a clumsy title is a small problem, and
 * failing the turn that produced it would be a much larger one.
 */
export async function nameConversation(
  inference: Inference,
  firstMessage: string,
  reply: string,
): Promise<string | null> {
  try {
    const response = await inference.generate("cheap", {
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Owner: ${firstMessage.slice(0, 600)}\n\nAgent: ${reply.slice(0, 600)}`,
            },
          ],
        },
      ],
    });
    return tidyName(textOf(response.content));
  } catch {
    return null;
  }
}
