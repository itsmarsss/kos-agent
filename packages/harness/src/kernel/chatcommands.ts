import { CHAT_COMMANDS } from "@kos/shared";
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
  | { kind: "fork"; title?: string }
  | { kind: "archive" }
  | { kind: "retry" }
  | { kind: "stop" }
  | { kind: "brief"; text?: string }
  | { kind: "agent"; title?: string }
  | { kind: "agents" }
  | { kind: "dispatch"; target: string; task: string }
  | { kind: "project"; name: string }
  | { kind: "approve"; id?: number }
  | { kind: "deny"; id?: number }
  | { kind: "status" }
  | { kind: "compact" }
  | { kind: "clear" }
  | { kind: "tools" }
  | { kind: "btw"; question: string }
  | { kind: "export" }
  | { kind: "files" }
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
  goto: "switch",
  rename: "rename",
  title: "rename",
  fork: "fork",
  copy: "fork",
  archive: "archive",
  close: "archive",
  done: "archive",
  retry: "retry",
  again: "retry",
  stop: "stop",
  cancel: "stop",
  brief: "brief",
  instructions: "brief",
  agent: "agent",
  spawn: "agent",
  agents: "agents",
  dispatch: "dispatch",
  delegate: "dispatch",
  project: "project",
  approve: "approve",
  yes: "approve",
  deny: "deny",
  no: "deny",
  reject: "deny",
  status: "status",
  compact: "compact",
  summarise: "compact",
  summarize: "compact",
  clear: "clear",
  reset: "clear",
  tools: "tools",
  scope: "tools",
  btw: "btw",
  aside: "btw",
  export: "export",
  download: "export",
  files: "files",
  workspace: "files",
  help: "help",
  "?": "help",
};

/** "#12" or "12" as a pending action's number; anything else is nothing. */
function actionNumber(arg: string): number | undefined {
  const n = Number(arg.replace(/^#/, ""));
  return arg !== "" && Number.isInteger(n) && n > 0 ? n : undefined;
}

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
    case "fork":
      return arg ? { kind: "fork", title: arg } : { kind: "fork" };
    case "agent":
      return arg ? { kind: "agent", title: arg } : { kind: "agent" };
    case "brief":
      return arg ? { kind: "brief", text: arg } : { kind: "brief" };
    case "switch":
      return arg ? { kind: "switch", target: arg } : { kind: "help" };
    case "rename":
      return arg ? { kind: "rename", title: arg } : { kind: "help" };
    case "project":
      return arg ? { kind: "project", name: arg } : { kind: "help" };
    case "btw":
      return arg ? { kind: "btw", question: arg } : { kind: "help" };
    case "dispatch": {
      // "<agent>: <task>": the colon is the seam, so a title may have spaces.
      const colon = arg.indexOf(":");
      const target = colon > 0 ? arg.slice(0, colon).trim() : "";
      const task = colon > 0 ? arg.slice(colon + 1).trim() : "";
      return target && task ? { kind: "dispatch", target, task } : { kind: "help" };
    }
    case "approve":
    case "deny": {
      const id = actionNumber(arg);
      return id === undefined ? { kind } : { kind, id };
    }
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
  /** A panel the surface should open, when the command is a request to. */
  opens?: "tools";
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
const HELP = [
  "Conversation commands:",
  ...CHAT_COMMANDS.map(
    (c) =>
      `\`/${c.name}${c.args ? ` ${c.args}` : ""}\` ${c.description}${c.where ? ` (${c.where} only)` : ""}`,
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

    case "brief": {
      const current = conversations.get(currentId);
      if (!current) return { reply: "No chat to brief." };
      if (command.text === undefined) {
        return {
          reply: current.brief
            ? `This chat's brief:\n\n${current.brief}`
            : "This chat has no brief. `/brief <text>` gives it standing instructions; `/brief -` clears them.",
        };
      }
      if (command.text === "-") {
        conversations.configure(currentId, { brief: null });
        return { reply: "Brief cleared." };
      }
      conversations.configure(currentId, { brief: command.text });
      return { reply: "Brief set. Every turn here starts from it." };
    }

    case "agent": {
      // An agent is a chat stamped with the project. It is named by its
      // first message like any other, unless a title came with the command.
      const slug = conversations.get(currentId)?.projectSlug;
      if (!slug) {
        return { reply: "This chat is not in a project. From a project's orchestrator or one of its agents, `/agent` starts another." };
      }
      const made = conversations.create({
        userId,
        channel,
        projectSlug: slug,
        ...(command.title ? { title: command.title } : {}),
      });
      conversations.setActive(channel, userId, made.id);
      return {
        reply: `Started an agent in this project${command.title ? ` as “${made.title}”` : ""}. Now on it: say what it should do.`,
        switchedTo: made.id,
      };
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

    case "tools":
      // Opening a panel is the caller's job; the kernel has no UI. Saying so
      // beats silence on a surface that cannot show one.
      return { reply: "Opening the tool scope for this chat.", opens: "tools" };

    case "btw":
    case "export":
    case "files":
      // The dashboard runs these itself before anything reaches here; on a
      // surface without one there is nothing to open or download.
      return { reply: `\`/${command.kind}\` works on the dashboard; this surface has nothing to open.` };

    case "fork":
    case "retry":
    case "stop":
    case "agents":
    case "dispatch":
    case "project":
    case "approve":
    case "deny":
    case "status":
    case "compact":
    case "clear":
      // Handled by the kernel, which owns the sessions, the queue and the
      // model. Reaching here means a caller ran the command table without
      // checking needsKernel first.
      return { reply: `\`/${command.kind}\` is not available on this surface.` };
  }
}

/**
 * Commands that need the kernel rather than the conversation store alone:
 * a chat's history, a running turn, the approval queue, the manifest.
 *
 * They are split out because everything else here is pure bookkeeping over
 * the conversation store, while these reach into what the kernel runs.
 * Keeping that distinction visible stops runChatCommand quietly becoming a
 * second agent loop.
 */
const KERNEL_KINDS: ReadonlySet<ChatCommand["kind"]> = new Set([
  "fork",
  "retry",
  "stop",
  "agents",
  "dispatch",
  "project",
  "approve",
  "deny",
  "status",
  "compact",
  "clear",
]);

export function needsKernel(command: ChatCommand): boolean {
  return KERNEL_KINDS.has(command.kind);
}
