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
 * Run one, and say what happened in a line.
 *
 * Every answer is text the surface shows only to whoever asked: this is
 * bookkeeping, and nobody else in a channel needs to watch someone change
 * where their messages go.
 */
export function runCommand(
  ctx: SlashContext,
  name: string,
  argument?: string,
): string {
  switch (name) {
    case "target": {
      if (!argument) return "Say which chat.";
      const found = ctx.list().find((c) => c.id === argument);
      if (!found) {
        // The picker sends an id; typed text that never matched a choice
        // arrives verbatim, so it is worth saying so rather than failing.
        return `No chat called "${argument}". Pick one from the list.`;
      }
      ctx.target(found.id);
      return `Sending to ${found.title}.`;
    }

    case "here": {
      const home = ctx.home();
      ctx.target(home);
      return "Back to this surface's own thread.";
    }

    case "chats": {
      const all = ctx.list().slice(0, 20);
      if (all.length === 0) return "No chats yet.";
      const current = ctx.current();
      return all
        .map((c) => `${c.id === current ? "→ " : "  "}${label(c)}`)
        .join("\n");
    }

    case "stop": {
      const where = ctx.current() ?? ctx.home();
      return ctx.stop(where)
        ? "Asked it to stop."
        : "Nothing is running in that chat.";
    }

    case "new": {
      const title = argument?.trim();
      if (!title) return "Say what the chat is for.";
      const made = ctx.create(title);
      ctx.target(made.id);
      return `Started ${made.title}, and sending there.`;
    }

    default:
      return `No such command: ${name}.`;
  }
}
