/**
 * Slash commands, answered by the daemon.
 *
 * None of these reach the model. They are bookkeeping the surface can do
 * itself -- where messages go, what threads exist, stopping a turn -- and
 * routing them through a turn would spend tokens and seconds to answer a
 * question the process already knows the answer to.
 *
 * They exist because the alternative was typing `/switch 3` blind. Discord
 * offers a real picker with autocomplete, so the thing you are choosing is
 * shown to you by name while you choose it.
 */

import type { MessageCard } from "./types.js";

/** What a command answers with. A card where the surface renders one. */
export interface SlashReply {
  text?: string;
  card?: MessageCard;
}

/** Muted blue, so an answer about bookkeeping does not read as an alert. */
const CARD_COLOR = 0x5865f2;

export interface SlashChoice {
  name: string;
  value: string;
}

/** What a command needs from the harness, so this file knows nothing of it. */
export interface SlashContext {
  /** Threads the owner may be sent to, newest first. */
  list(): { id: string; title: string; kind: string }[];
  /** Where this surface currently sends messages. */
  current(): string | undefined;
  /** Point the surface at a thread. */
  target(conversationId: string): void;
  /** The surface's own stream, which is where /here goes. */
  home(): string;
  /** Ask whatever is running in a thread to stop. Answers whether it did. */
  stop(conversationId: string): boolean;
  /** Start a thread and point at it. */
  create(title: string): { id: string; title: string };
}

export interface SlashSpec {
  name: string;
  description: string;
  /** One optional string argument, offered with autocomplete when true. */
  argument?: { name: string; description: string; autocomplete: boolean };
}

export const COMMANDS: SlashSpec[] = [
  {
    name: "target",
    description: "Send what you say next to a particular chat",
    argument: { name: "chat", description: "which one", autocomplete: true },
  },
  {
    name: "here",
    description: "Go back to this surface's own thread",
  },
  {
    name: "chats",
    description: "List the chats you can be sent to",
  },
  {
    name: "stop",
    description: "Stop whatever the current chat is doing",
  },
  {
    name: "new",
    description: "Start a chat and send what you say next to it",
    argument: { name: "title", description: "what it is for", autocomplete: false },
  },
];

/**
 * A chat's name as the picker shows it.
 *
 * Discord will not display a choice longer than a hundred characters, and a
 * title here is the owner's first message, so most of them are longer.
 */
function label(chat: { title: string; kind: string }): string {
  const mark =
    chat.kind === "surface" ? "# " : chat.kind === "schedule" ? "⏱ " : "";
  const name = `${mark}${chat.title}`;
  return name.length > 90 ? `${name.slice(0, 89)}…` : name;
}

/** Chats matching what has been typed so far, for the picker. */
export function completions(ctx: SlashContext, typed: string): SlashChoice[] {
  const needle = typed.trim().toLowerCase();
  return ctx
    .list()
    .filter((c) => !needle || c.title.toLowerCase().includes(needle))
    // Discord shows at most twenty-five.
    .slice(0, 25)
    .map((c) => ({ name: label(c), value: c.id }));
}

/**
 * Run one, and say what happened.
 *
 * A card rather than a sentence, because the interesting word in most of
 * these answers is a chat's title, and a title here is the owner's first
 * message: "Sending to what capabilities does notify have (fork)." is a
 * sentence that has eaten its own subject. Given a heading of its own it
 * reads as the name of a thing again.
 *
 * Shown only to whoever asked. Where someone sends their messages is not
 * news for a channel.
 */
export function runCommand(
  ctx: SlashContext,
  name: string,
  argument?: string,
): SlashReply {
  switch (name) {
    case "target": {
      if (!argument) return { text: "Say which chat." };
      const found = ctx.list().find((c) => c.id === argument);
      if (!found) {
        // The picker sends an id; text typed past the list arrives verbatim.
        return {
          text: `No chat called "${argument}". Pick one from the list.`,
        };
      }
      ctx.target(found.id);
      return {
        card: {
          title: "Now sending to",
          body: found.title,
          color: CARD_COLOR,
          footer: "Until you use /here or /target again",
        },
      };
    }

    case "here": {
      ctx.target(ctx.home());
      return {
        card: {
          title: "Back to this surface",
          body: "Messages land in this surface's own thread again.",
          color: CARD_COLOR,
        },
      };
    }

    case "chats": {
      const all = ctx.list();
      if (all.length === 0) return { text: "No chats yet." };
      const current = ctx.current();
      const streams = all.filter((c) => c.kind === "surface");
      const chats = all.filter((c) => c.kind !== "surface");
      const line = (c: { id: string; title: string }): string =>
        c.id === current ? `**${trim(c.title)}**  ← here` : trim(c.title);
      return {
        card: {
          title: "Where you can send",
          color: CARD_COLOR,
          fields: [
            ...(streams.length
              ? [{ name: "Streams", value: streams.map(line).join("\n") }]
              : []),
            ...(chats.length
              ? [
                  {
                    name: "Chats",
                    // A field holds a thousand characters, and a title here
                    // is a whole message, so this is a page rather than all
                    // of them. /target searches the lot.
                    value: fit(chats.slice(0, 15).map(line)),
                  },
                ]
              : []),
          ],
          footer:
            chats.length > 15
              ? `${chats.length - 15} more. Use /target to search them all.`
              : "Use /target to pick one",
        },
      };
    }

    case "stop": {
      const where = ctx.current() ?? ctx.home();
      return ctx.stop(where)
        ? { text: "Asked it to stop." }
        : { text: "Nothing is running in that chat." };
    }

    case "new": {
      const title = argument?.trim();
      if (!title) return { text: "Say what the chat is for." };
      const made = ctx.create(title);
      ctx.target(made.id);
      return {
        card: {
          title: "Started, and sending there",
          body: made.title,
          color: CARD_COLOR,
        },
      };
    }

    default:
      return { text: `No such command: ${name}.` };
  }
}

/** One line of a list, short enough that a dozen of them still fit. */
function trim(title: string): string {
  return title.length > 60 ? `${title.slice(0, 59)}…` : title;
}

/** As many lines as a field will hold, rather than a field that is refused. */
function fit(lines: string[]): string {
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > 1000) break;
    out.push(line);
    used += line.length + 1;
  }
  return out.join("\n");
}
