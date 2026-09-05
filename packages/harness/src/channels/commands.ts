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
/** Grey, for an answer where nothing changed. */
const CARD_MUTED = 0x4f545c;

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
  /**
   * Where to read a thread, if the dashboard can be reached.
   *
   * A chat named in an answer is a thing the owner may want to open, and a
   * name they cannot click is a name they have to go and find.
   */
  link?(conversationId: string): string | undefined;
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
 * A name the owner can click, where there is somewhere to send them.
 *
 * A chat named in an answer is usually one they want to look at, and a name
 * they cannot open is a name they have to go and find.
 */
function named(ctx: SlashContext, chat: { id: string; title: string }): string {
  const url = ctx.link?.(chat.id);
  const name = trim(chat.title);
  // Brackets and parentheses in a title would close the link early.
  return url ? `**[${name.replace(/[[\]()]/g, "")}](${url})**` : `**${name}**`;
}

/**
 * Run one, and say what happened.
 *
 * All of them answer with a card, and the same card: a heading for what
 * changed, the chat it changed to as something clickable, and a footer
 * saying what to do next. Answers that each invented their own shape read
 * as unrelated features rather than one set of commands.
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
      // Nothing picked is a question, not a mistake: show the list.
      if (!argument) return runCommand(ctx, "chats");
      const found = ctx.list().find((c) => c.id === argument);
      if (!found) {
        return {
          card: {
            title: "No such chat",
            body: `Nothing here is called \`${trim(argument)}\`. Pick one from the list /target offers.`,
            color: CARD_MUTED,
          },
        };
      }
      ctx.target(found.id);
      return {
        card: {
          title: "Now sending to",
          body: named(ctx, found),
          color: CARD_COLOR,
          footer: "/here comes back · /target moves again",
        },
      };
    }

    case "here": {
      const home = ctx.home();
      ctx.target(home);
      const stream = ctx.list().find((c) => c.id === home);
      return {
        card: {
          title: "Back to this surface",
          body: stream
            ? `Messages land in ${named(ctx, stream)} again.`
            : "Messages land in this surface's own thread again.",
          color: CARD_COLOR,
          footer: "/target sends them somewhere else",
        },
      };
    }

    case "chats": {
      const all = ctx.list();
      const chats = all.filter((c) => c.kind !== "surface");
      if (chats.length === 0) {
        return {
          card: {
            title: "No chats yet",
            body: "Say something here, or start one with `/new`.",
            color: CARD_MUTED,
          },
        };
      }
      const current = ctx.current();
      const shown = chats.slice(0, LISTED);
      /*
       * One fenced block, not a pill each.
       *
       * Inline code gives every entry its own box, and boxes of fifteen
       * different widths are a ragged edge rather than a list. In one block
       * they share a left margin and a typeface, which is what makes a list
       * scannable.
       */
      const rows = shown.map(
        (c) => `${c.id === current ? "→" : " "} ${trim(c.title)}`,
      );
      const here = chats.find((c) => c.id === current);
      return {
        card: {
          title: "Where you can send",
          ...(here ? { body: `Currently ${named(ctx, here)}` } : {}),
          color: CARD_COLOR,
          fields: [{ name: "\u200b", value: fence(rows) }],
          footer:
            chats.length > LISTED
              ? `${chats.length} in all · /target searches every one · /here comes back`
              : "/target moves you · /here comes back",
        },
      };
    }

    case "stop": {
      const where = ctx.current() ?? ctx.home();
      const chat = ctx.list().find((c) => c.id === where);
      const asked = ctx.stop(where);
      return {
        card: {
          title: asked ? "Asked it to stop" : "Nothing to stop",
          body: chat
            ? asked
              ? `${named(ctx, chat)} will stop at the first thing it can leave cleanly.`
              : `${named(ctx, chat)} is not doing anything.`
            : undefined,
          color: asked ? CARD_COLOR : CARD_MUTED,
        },
      };
    }

    case "new": {
      const title = argument?.trim();
      if (!title) {
        return {
          card: {
            title: "Say what it is for",
            body: "`/new taxes 2026` starts a chat and sends you there.",
            color: CARD_MUTED,
          },
        };
      }
      const made = ctx.create(title);
      ctx.target(made.id);
      return {
        card: {
          title: "Started, and sending there",
          body: named(ctx, made),
          color: CARD_COLOR,
          footer: "/here comes back",
        },
      };
    }

    default:
      return {
        card: {
          title: "No such command",
          body: `\`/${name}\` is not one of mine.`,
          color: CARD_MUTED,
        },
      };
  }
}

/**
 * A block, so entries share a margin instead of each having a box.
 *
 * Kept inside what a field will hold: Discord refuses a message whose field
 * runs past a thousand characters rather than trimming it, so a long list
 * would take the whole answer with it.
 */
function fence(rows: string[]): string {
  const kept: string[] = [];
  let used = "```\n```".length;
  for (const row of rows) {
    if (used + row.length + 1 > 1000) break;
    kept.push(row);
    used += row.length + 1;
  }
  return ["```", kept.join("\n"), "```"].join("\n");
}

/** How many chats to list. Enough to find one without opening the picker. */
const LISTED = 15;

/** One line of a list, cut at a word so it does not end mid-syllable. */
function trim(title: string): string {
  if (title.length <= 40) return title;
  const cut = title.slice(0, 39);
  const space = cut.lastIndexOf(" ");
  return `${(space > 20 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
