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
  /** Set when only the dashboard can do it; other surfaces say so. */
  where?: "dashboard";
}

export const CHAT_COMMANDS: CommandSpec[] = [
  { name: "new", args: "[title]", description: "start another conversation" },
  { name: "chats", description: "list your conversations" },
  { name: "switch", args: "<number|title>", description: "move to one" },
  { name: "rename", args: "<title>", description: "rename this conversation" },
  { name: "fork", args: "[title]", description: "copy this chat, history and all, and move to the copy" },
  { name: "archive", description: "close this conversation" },
  { name: "retry", description: "ask the last message again" },
  { name: "stop", description: "stop the turn running here" },
  { name: "brief", args: "[text]", description: "show or set this chat's standing instructions" },
  { name: "agent", args: "[title]", description: "start an agent in this project and move to it" },
  { name: "agents", description: "list this project's agents and what they are doing" },
  { name: "dispatch", args: "<agent>: <task>", description: "hand a task to an agent" },
  { name: "project", args: "<name>", description: "stand up a project with its orchestrator" },
  { name: "approve", args: "[#]", description: "approve what this chat is waiting on" },
  { name: "deny", args: "[#]", description: "deny it" },
  { name: "status", description: "what is running, and what is waiting on you" },
  {
    name: "compact",
    description: "replace this chat's history with a summary of it",
  },
  { name: "clear", description: "forget this chat's history, keep the chat" },
  { name: "tools", description: "choose which tools this chat may use" },
  { name: "btw", args: "<question>", description: "a side question about this chat, without adding to it", where: "dashboard" },
  { name: "export", description: "download this chat as markdown", where: "dashboard" },
  { name: "files", description: "open this project's files", where: "dashboard" },
  { name: "help", description: "show these commands" },
];

/** Every command name, longest first so /chats is not matched as /chat. */
export const COMMAND_NAMES: string[] = CHAT_COMMANDS.map((c) => c.name).sort(
  (a, b) => b.length - a.length,
);
