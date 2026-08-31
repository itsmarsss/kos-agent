import { summarizeAction } from "@kos/shared";

import type { ModelMessage } from "../models/types.js";
import { parseQueuedApproval } from "./guarded.js";

/**
 * A conversation rendered for a reader rather than for the model.
 *
 * The stored transcript keeps tool_use and tool_result blocks so a follow-up
 * turn has its context, but a chat view that hides them shows an agent
 * asserting things with no visible reason. These events keep the work in the
 * open: what it called, with what, and what came back.
 */

/** An attachment as a reader needs it: a name, and either an image or text. */
export interface Attachment {
  name: string;
  /** Data URI, for an image. */
  src?: string;
  /** File contents, for a text file. */
  text?: string;
}

export type ChatEvent =
  | {
      /** What the model worked out before answering, kept so it can be reread. */
      kind: "reasoning";
      text: string;
    }
  | {
      kind: "message";
      role: "you" | "kos" | "system";
      text: string;
      /**
       * What was attached to this turn. Kept as things with names rather than
       * flattened into the message, so the reader sees what they sent and can
       * open it.
       */
      attachments?: Attachment[];
    }
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
      /**
       * Set when the call was held for approval instead of running. Without
       * this a queued call reads as a successful one that did nothing.
       */
      pendingId?: string;
    };

const MAX_RESULT = 2000;

/**
 * The harness resumes a held call by sending itself a user turn. That is the
 * right shape for the model and the wrong one for a reader, who sees a wall of
 * plumbing attributed to them. Recognised here and reduced to a one-line note.
 */
function approvalNote(text: string): string | null {
  const approved = /^System: the owner approved pending action #(\d+)\./.exec(text);
  if (approved) {
    const tool = /\btool=(\S+)/.exec(text)?.[1] ?? "action";
    const failed = /\boutcome=FAILED\b/.test(text);
    return `Approved #${approved[1]} · ${tool} ${failed ? "failed" : "ran"}`;
  }
  const denied = /^System: the owner denied pending action #(\d+)\./.exec(text);
  return denied ? `Denied #${denied[1]}` : null;
}

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
      if (block.type === "reasoning") {
        const text = block.text.trim();
        if (text) events.push({ kind: "reasoning", text });
        continue;
      }

      if (block.type === "image" || block.type === "file") {
        // Attached to the turn it belongs to: a transcript that drops these
        // leaves a question about something no longer on screen.
        const attachment: Attachment =
          block.type === "image"
            ? {
                name: block.name ?? "image",
                src: `data:${block.mediaType};base64,${block.data}`,
              }
            : { name: block.name, text: block.text };
        const last = events.at(-1);
        if (last?.kind === "message" && last.role === "you") {
          last.attachments = [...(last.attachments ?? []), attachment];
        } else {
          events.push({
            kind: "message",
            role: "you",
            text: "",
            attachments: [attachment],
          });
        }
        continue;
      }

      if (block.type === "text") {
        const text = block.text.trim();
        if (text) {
          const note = message.role === "user" ? approvalNote(text) : null;
          events.push(
            note
              ? { kind: "message", role: "system", text: note }
              : {
                  kind: "message",
                  role: message.role === "user" ? "you" : "kos",
                  text,
                },
          );
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
          const queued = parseQueuedApproval(block.content);
          if (queued) target.pendingId = queued;
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
