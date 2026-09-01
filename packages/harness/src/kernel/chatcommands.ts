import type { Conversation, ConversationStore } from "./conversations.js";

/**
 * Conversation commands, parsed in the kernel rather than in any adapter.
 *
 * A surface with native threads (Slack, a Discord guild thread) can map a
 * thread to a conversation and never need these. A plain DM has one stream of
 * messages, so switching has to be something you can type. Putting the verbs
 * here means every channel gets the same ones for free, and the CLI and the
 * dashboard behave identically to Discord.
 */

export type ChatCommand =
  | { kind: "new"; title?: string }
  | { kind: "list" }
  | { kind: "switch"; target: string }
  | { kind: "rename"; title: string }
  | { kind: "archive" }
  | { kind: "compact" }
  | { kind: "clear" }
  | { kind: "help" };

const ALIASES: Record<string, ChatCommand["kind"]> = {
  new: "new",
  n: "new",
  chats: "list",
  chat: "list",
  ls: "list",
  list: "list",
  switch: "switch",
  s: "switch",
  go: "switch",
  rename: "rename",
  title: "rename",
  archive: "archive",
  close: "archive",
  done: "archive",
  compact: "compact",
  summarise: "compact",
  summarize: "compact",
  clear: "clear",
  reset: "clear",
  help: "help",
  "?": "help",
};

/**
 * Recognise a leading slash command. Anything else is a message for the agent,
 * including text that merely contains a slash.
 */
export function parseChatCommand(text: string): ChatCommand | null {
  const line = text.trim();
  if (!line.startsWith("/")) return null;

  const [word, ...rest] = line.slice(1).split(/\s+/);
  const kind = ALIASES[(word ?? "").toLowerCase()];
  if (!kind) return null;
  const arg = rest.join(" ").trim();

  switch (kind) {
    case "new":
      return arg ? { kind: "new", title: arg } : { kind: "new" };
    case "switch":
      return arg ? { kind: "switch", target: arg } : { kind: "help" };
    case "rename":
      return arg ? { kind: "rename", title: arg } : { kind: "help" };
    default:
      return { kind };
  }
}

/**
 * Find a conversation from what someone typed: the position shown by /chats,
 * an exact id, or a case-insensitive title prefix. Positions are what people
 * actually use, so they win.
 */
export function resolveConversation(
  list: Conversation[],
  target: string,
): Conversation | undefined {
  const trimmed = target.trim();
  const index = Number(trimmed);
  if (Number.isInteger(index) && index >= 1 && index <= list.length) {
    return list[index - 1];
  }
  const exact = list.find((c) => c.id === trimmed);
  if (exact) return exact;
  const lower = trimmed.toLowerCase();
  return (
    list.find((c) => c.title.toLowerCase() === lower) ??
    list.find((c) => c.title.toLowerCase().startsWith(lower))
  );
}

export interface CommandContext {
  conversations: ConversationStore;
  channel: string;
  userId: string;
  /** The conversation this surface is currently pointed at. */
  currentId: string;
}

export interface CommandResult {
  reply: string;
  /** Set when the command moved this surface to a different conversation. */
  switchedTo?: string;
}

/**
 * Every command, once.
 *
 * The dashboard's autocomplete and the help text both read this, so a command
 * cannot exist in one and be missing from the other.
 */
export interface CommandSpec {
  name: string;
  args?: string;
  description: string;
}

export const CHAT_COMMANDS: CommandSpec[] = [
  { name: "new", args: "[title]", description: "start another conversation" },
  { name: "chats", description: "list your conversations" },
  { name: "switch", args: "<number|title>", description: "move to one" },
  { name: "rename", args: "<title>", description: "rename this conversation" },
  { name: "archive", description: "close this conversation" },
  {
    name: "compact",
    description: "replace this chat's history with a summary of it",
  },
  { name: "clear", description: "forget this chat's history, keep the chat" },
  { name: "help", description: "show these commands" },
];

const HELP = [
  "Conversation commands:",
  ...CHAT_COMMANDS.map(
    (c) => `\`/${c.name}${c.args ? ` ${c.args}` : ""}\` ${c.description}`,
  ),
].join("\n");

function line(c: Conversation, i: number, currentId: string): string {
  const here = c.id === currentId ? " ← here" : "";
  return `${i + 1}. ${c.title}${here}`;
}

/** Run a parsed command. Never touches the agent loop or the model. */
export function runChatCommand(
  command: ChatCommand,
  ctx: CommandContext,
): CommandResult {
  const { conversations, channel, userId, currentId } = ctx;

  switch (command.kind) {
    case "help":
      return { reply: HELP };

    case "new": {
      const created = conversations.create({
        userId,
        channel,
        ...(command.title ? { title: command.title } : {}),
      });
      conversations.setActive(channel, userId, created.id);
      return {
        reply: `Started “${created.title}”. This surface is now on it; \`/chats\` lists the rest.`,
        switchedTo: created.id,
      };
    }

    case "list": {
      const list = conversations.list(userId);
      if (list.length === 0) return { reply: "No conversations yet." };
      return {
        reply: [
          `${list.length} conversation${list.length === 1 ? "" : "s"}:`,
          ...list.map((c, i) => line(c, i, currentId)),
          "",
          "`/switch <number>` to move.",
        ].join("\n"),
      };
    }

    case "switch": {
      const list = conversations.list(userId);
      const found = resolveConversation(list, command.target);
      if (!found) {
        return { reply: `No conversation matches “${command.target}”. Try \`/chats\`.` };
      }
      if (found.id === currentId) {
        return { reply: `Already on “${found.title}”.` };
      }
      conversations.setActive(channel, userId, found.id);
      return { reply: `Now on “${found.title}”.`, switchedTo: found.id };
    }

    case "rename": {
      const renamed = conversations.rename(currentId, command.title);
      return { reply: renamed ? `Renamed to “${renamed.title}”.` : "Nothing to rename." };
    }

    case "archive": {
      const current = conversations.get(currentId);
      if (!current) return { reply: "Nothing to archive." };
      conversations.setArchived(currentId, true);
      // Land somewhere real rather than on an archived conversation.
      const remaining = conversations.list(userId);
      const next =
        remaining[0] ??
        conversations.create({ userId, channel, title: "New conversation" });
      conversations.setActive(channel, userId, next.id);
      return {
        reply: `Archived “${current.title}”. Now on “${next.title}”.`,
        switchedTo: next.id,
      };
    }

    case "compact":
    case "clear":
      // Handled by the kernel, which owns the session history and (for
      // compact) the model. Reaching here means a caller ran the command
      // table without checking touchesHistory first.
      return { reply: `\`/${command.kind}\` is not available on this surface.` };
  }
}

/**
 * Commands that act on a conversation's history rather than on the list of
 * conversations.
 *
 * They are split out because everything else here is pure bookkeeping over the
 * conversation store, while these need the session history and, for compact,
 * a model call. Keeping that distinction visible stops runChatCommand quietly
 * becoming a second agent loop.
 */
export function touchesHistory(command: ChatCommand): boolean {
  return command.kind === "compact" || command.kind === "clear";
}
