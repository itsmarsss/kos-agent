import type { ContentBlock, ModelMessage } from "../models/types.js";

/**
 * Pictures tools answered with, kept to what the model needs.
 *
 * A tool that looks (a browser tab, a computer's screen) answers with a
 * picture, and a session of clicks is dozens of them. Sent whole every round
 * trip, each one costs its tokens again on every later call, and kept in a
 * stored history they crowd out the words the history is for. What matters
 * is the screen as it is now: the last few pictures go to the model, older
 * ones are named as dropped, and none are stored, since the owner's copy of
 * each step's picture is kept apart for the dashboard.
 */

/** How many of the latest pictures the model is sent. */
export const RECENT_PICTURES = 3;

const DROPPED = "\n(A picture came with this and was dropped to save room; look again if you need it.)";

function stripped(block: ContentBlock): ContentBlock {
  if (block.type !== "tool_result" || !block.images?.length) return block;
  const { images: _gone, ...rest } = block;
  return { ...rest, content: `${block.content}${DROPPED}` };
}

/** The messages with only the latest `keep` tool pictures left in; the input is not changed. */
export function keepRecentPictures(messages: ModelMessage[], keep = RECENT_PICTURES): ModelMessage[] {
  let left = keep;
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    const message = out[i]!;
    if (!message.content.some((b) => b.type === "tool_result" && b.images?.length)) continue;
    const content = [...message.content];
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j]!;
      if (block.type !== "tool_result" || !block.images?.length) continue;
      if (left > 0) left -= 1;
      else content[j] = stripped(block);
    }
    out[i] = { ...message, content };
  }
  return out;
}

/** The messages with every tool picture taken out, for storing. */
export function withoutPictures(messages: ModelMessage[]): ModelMessage[] {
  return keepRecentPictures(messages, 0);
}
