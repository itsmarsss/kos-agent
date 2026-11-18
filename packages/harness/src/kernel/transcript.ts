import { summarizeAction } from "@kos/shared";

import { heardWith } from "../models/heard.js";
import { saidText, type MessageOrigin, type ModelMessage, type Quote } from "../models/types.js";
import { RESUME_HEAD } from "./decisions.js";
import { parseQueuedApproval } from "./guarded.js";
import type { EarlierHistory } from "./session.js";

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
  /** Where the file is kept in the workspace, when it is, so the reader can open it as itself. */
  path?: string;
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
      /** Where it came from, when not typed here by the owner: the surface and room, a guest, a schedule, the chat that sent it. */
      origin?: MessageOrigin;
      /** What the owner quoted with it (text selected on a page), and where from: shown with their words, never as them. */
      quote?: Quote;
      /** When it was written to the chat, epoch milliseconds; absent when it was kept before messages kept their time. */
      at?: number;
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
      /** The model's id for the call, so a picture taken after it can find its card. */
      toolUseId?: string;
      /** A picture of the browser after this step, at /api/frames/:id. */
      frameId?: number;
      /** How long it ran, ms, not counting a wait for the owner's yes; absent for a call kept before calls were timed. */
      ms?: number;
      /** How long it waited on the owner's yes, ms, when it asked. */
      waitedMs?: number;
    }
  | {
      /** A line across the chat where it was cleared or compacted: what is above is kept for the reader, not for the model. */
      kind: "divider";
      text: string;
      at: number;
    };

const MAX_RESULT = 2000;

/** One decided action in a resume, as a note: today's words, or the outcome lines that came before them. */
function decidedNote(line: string): string | null {
  const now = /^- @approval:(\d+) (.+?): the owner (approved it, and it ran and failed|approved it, and it ran|denied this)\./.exec(line);
  if (now) {
    const [, id, what, how] = now;
    if (how === "denied this") return `Denied #${id} · ${what}`;
    return `Approved #${id} · ${what}${how!.endsWith("failed") ? " · failed" : ""}`;
  }
  const before = /^- #(\d+) (\S+): (?:approved and run, (SUCCEEDED|FAILED)|denied by the owner)/.exec(line);
  if (!before) return null;
  const [, id, tool, ran] = before;
  return ran ? `Approved #${id} · ${tool} ${ran === "FAILED" ? "failed" : "ran"}` : `Denied #${id} · ${tool}`;
}

/**
 * The harness resumes a held call by sending itself a user turn. That is the
 * right shape for the model and the wrong one for a reader, who sees a wall of
 * plumbing attributed to them. Recognised here and reduced to a one-line note,
 * in each of the shapes a stored chat may hold.
 */
function approvalNote(text: string): string | null {
  if (text.startsWith(RESUME_HEAD)) {
    const notes = text.split("\n").flatMap((line) => decidedNote(line) ?? []);
    return notes.length ? notes.join("; ") : null;
  }
  // The oldest shape: one action per resume.
  const approved = /^System: the owner approved pending action #(\d+)\./.exec(text);
  if (approved) {
    const tool = /\btool=(\S+)/.exec(text)?.[1] ?? "action";
    return `Approved #${approved[1]} · ${tool} ${/\boutcome=FAILED\b/.test(text) ? "failed" : "ran"}`;
  }
  const denied = /^System: the owner denied pending action #(\d+)\./.exec(text);
  return denied ? `Denied #${denied[1]}` : null;
}

function textOf(content: ModelMessage["content"]): string {
  return saidText(content).trim();
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
    const at = message.at ? { at: message.at } : {};
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
                ...(block.path ? { path: block.path } : {}),
              }
            : { name: block.name, text: block.text, ...(block.path ? { path: block.path } : {}) };
        const last = events.at(-1);
        if (last?.kind === "message" && last.role === "you") {
          last.attachments = [...(last.attachments ?? []), attachment];
        } else {
          events.push({
            kind: "message",
            role: "you",
            text: "",
            attachments: [attachment],
            ...(message.origin ? { origin: message.origin } : {}),
            ...at,
          });
        }
        continue;
      }

      if (block.type === "text") {
        // Room talk kept beside a guest-room message is the model's context, not a line anyone typed here.
        if (block.guestContext) continue;
        // A quote goes with the owner's words it came with.
        if (block.quote) {
          const last = events.at(-1);
          if (last?.kind === "message" && last.role === "you") last.quote = { text: block.quote.text, from: block.quote.from };
          continue;
        }
        const text = block.text.trim();
        if (text) {
          const note = message.role === "user" ? approvalNote(text) : null;
          events.push(
            note
              ? { kind: "message", role: "system", text: note, ...at }
              : {
                  kind: "message",
                  role: message.role === "user" ? "you" : "kos",
                  text,
                  ...(message.role === "user" && message.origin ? { origin: message.origin } : {}),
                  ...at,
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
          toolUseId: block.id,
        };
        pending.set(block.id, event);
        events.push(event);
        continue;
      }

      if (block.type === "tool_result") {
        // Attach to the call it answers; an unmatched result is a fragment
        // from an older truncation and has nothing to attach to.
        const target = pending.get(block.toolUseId);
        const { content, said } = heardWith(block);
        if (target) {
          target.result = content.slice(0, MAX_RESULT);
          if (block.isError) target.isError = true;
          if (block.ms !== undefined) target.ms = block.ms;
          if (block.waitedMs !== undefined) target.waitedMs = block.waitedMs;
          const queued = parseQueuedApproval(content);
          if (queued) target.pendingId = queued;
          pending.delete(block.toolUseId);
        }
        // What the owner said while the turn ran, where the turn heard it, and when: the step that took it in.
        for (const w of said) events.push({ kind: "message", role: "you", text: w.text, ...(w.via ? { origin: { via: w.via } } : {}), ...at });
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

/**
 * The whole chat as a reader sees it: every stretch set aside by a clear or
 * a compaction, each under a line saying so, then the chat as the model has
 * it now.
 */
export function historyEvents(earlier: EarlierHistory[], current: ModelMessage[]): ChatEvent[] {
  const out: ChatEvent[] = [];
  for (const stretch of earlier) {
    out.push(...conversationEvents(stretch.messages));
    out.push({
      kind: "divider",
      at: stretch.at,
      text: stretch.why === "compacted" ? "Compacted here: what is above was folded into the summary below" : "Cleared here: what is above is kept for you, not for KOS",
    });
  }
  out.push(...conversationEvents(current));
  return out;
}
