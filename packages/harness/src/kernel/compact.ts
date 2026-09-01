import type { Inference } from "../agent/loop.js";
import type { ModelMessage } from "../models/types.js";

/**
 * Turning a long conversation into a short one that still knows things.
 *
 * KOS already bounds how much history it keeps, but it does it by dropping:
 * past the retention budget, the oldest exchanges fall off the front and what
 * was decided in them is simply gone. That is the right behaviour for a
 * runaway thread and the wrong one for a long piece of work, where the early
 * turns are where the decisions were made.
 *
 * Compacting replaces the history with an account of it. The conversation gets
 * shorter and keeps its memory, rather than getting shorter by losing it.
 */

/** Marks history that is a summary rather than a transcript. */
export const COMPACTED_PREFIX = "[Earlier in this conversation]";

const PROMPT = [
  "Summarise this conversation so it can replace the transcript.",
  "",
  "You are writing notes for yourself to pick the work back up. Someone",
  "reading only your summary should be able to continue without asking the",
  "owner to repeat themselves. Keep:",
  "",
  "- what the owner asked for, and any constraint or preference they stated",
  "- decisions made and the reason, especially ones that would otherwise be",
  "  relitigated",
  "- what was actually done: files written, projects and pages created, tools",
  "  run and what came back, with real names and ids rather than descriptions",
  "- what is unfinished, and what the next step was going to be",
  "- anything the owner corrected you about",
  "",
  "Drop pleasantries, retries, and reasoning that led nowhere. Do not invent",
  "anything that is not in the transcript, and do not soften a failure into a",
  "success: if something did not work, say so.",
  "",
  "Write it as prose and short lists. No preamble, no sign-off.",
].join("\n");

/** Flatten a message's blocks into something a model can read back. */
function render(message: ModelMessage): string {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "tool_use") {
      parts.push(`[called ${block.name} ${JSON.stringify(block.input).slice(0, 400)}]`);
    } else if (block.type === "tool_result") {
      const body =
        typeof block.content === "string" ? block.content : JSON.stringify(block.content);
      parts.push(`[result${block.isError ? " (error)" : ""}: ${body.slice(0, 600)}]`);
    } else if (block.type === "file") {
      parts.push(`[file ${block.name}]`);
    }
    // Thinking and reasoning blocks are the model talking to itself. What it
    // concluded is in the text and the tool calls, which are already here.
  }
  return `${message.role}: ${parts.join("\n")}`;
}

export interface CompactResult {
  /** The history to store in place of the old one. */
  messages: ModelMessage[];
  summary: string;
  /** How many messages were folded into it. */
  compacted: number;
}

/**
 * Summarise a history and return what should replace it.
 *
 * The replacement is a single user-role message. It is framed as context
 * rather than as something the owner said, so the model treats it as the
 * record it is; putting it in the assistant's voice invited it to defend the
 * summary as its own prior turn.
 */
export async function compactHistory(
  inference: Inference,
  history: ModelMessage[],
): Promise<CompactResult | null> {
  // Nothing to gain below this: the summary would be longer than the thing.
  if (history.length < 4) return null;

  const transcript = history.map(render).join("\n\n");
  const response = await inference.generate("reasoning", {
    system: PROMPT,
    messages: [{ role: "user", content: [{ type: "text", text: transcript }] }],
  });

  const summary = response.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  // A summary that came back empty must not be allowed to replace a real
  // history: that would turn a compaction into a silent /clear.
  if (!summary) return null;

  return {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: `${COMPACTED_PREFIX}\n\n${summary}` }],
      },
    ],
    summary,
    compacted: history.length,
  };
}
