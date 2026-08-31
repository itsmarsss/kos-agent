import { summarizeAction } from "@kos/shared";

import type { ModelMessage } from "../models/types.js";

/**
 * A conversation rendered for a reader rather than for the model.
 *
 * The stored transcript keeps tool_use and tool_result blocks so a follow-up
 * turn has its context, but a chat view that hides them shows an agent
 * asserting things with no visible reason. These events keep the work in the
 * open: what it called, with what, and what came back.
 */

export type ChatEvent =
  | { kind: "message"; role: "you" | "kos"; text: string }
  | {
      kind: "tool";
      /** Tool name, e.g. "sql". */
      name: string;
      /** One-line human summary of the call. */
      summary: string;
      args: Record<string, unknown>;
      /** Result text, present once the matching tool_result arrives. */
      result?: string;
      isError?: boolean;
    };

const MAX_RESULT = 2000;

function textOf(content: ModelMessage["content"]): string {
  return content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("")
    .trim();
}

/**
 * Walk a stored transcript into ordered events, pairing each tool call with
 * the result that came back for it.
 */
export function conversationEvents(messages: ModelMessage[]): ChatEvent[] {
  const events: ChatEvent[] = [];
  // tool_use id -> the event waiting for its result.
  const pending = new Map<string, Extract<ChatEvent, { kind: "tool" }>>();

  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "text") {
        const text = block.text.trim();
        if (text) {
          events.push({
            kind: "message",
            role: message.role === "user" ? "you" : "kos",
            text,
          });
        }
        continue;
      }

      if (block.type === "tool_use") {
        const event: Extract<ChatEvent, { kind: "tool" }> = {
          kind: "tool",
          name: block.name,
          summary: summarizeAction(block.name, block.input),
          args: block.input,
        };
        pending.set(block.id, event);
        events.push(event);
        continue;
      }

      if (block.type === "tool_result") {
        // Attach to the call it answers; an unmatched result is a fragment
        // from an older truncation and has nothing to attach to.
        const target = pending.get(block.toolUseId);
        if (target) {
          target.result = block.content.slice(0, MAX_RESULT);
          if (block.isError) target.isError = true;
          pending.delete(block.toolUseId);
        }
      }
    }
  }

  return events;
}

/** Just the spoken turns, for surfaces that only want the conversation. */
export function spokenTurns(
  messages: ModelMessage[],
): Array<{ role: "you" | "kos"; text: string }> {
  return messages
    .map((m) => ({
      role: (m.role === "user" ? "you" : "kos") as "you" | "kos",
      text: textOf(m.content),
    }))
    .filter((t) => t.text !== "");
}
