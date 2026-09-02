/**
 * The slash commands a conversation understands.
 *
 * Shared because three places need to agree on the list and none of them can
 * derive it: the harness dispatches on it, the composer highlights it, and
 * the transcript renders it as a chip. Kept in one file after the renderer's
 * private copy went stale and /compact, /clear and /tools stopped being
 * recognised as commands at all.
 */

export interface CommandSpec {
  name: string;
  /** Placeholder for what follows the command, where it takes something. */
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
  { name: "tools", description: "choose which tools this chat may use" },
  { name: "help", description: "show these commands" },
];

/** Every command name, longest first so /chats is not matched as /chat. */
export const COMMAND_NAMES: string[] = CHAT_COMMANDS.map((c) => c.name).sort(
  (a, b) => b.length - a.length,
);
