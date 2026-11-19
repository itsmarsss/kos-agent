/**
 * The slash commands a conversation understands.
 *
 * Shared because three places need to agree on the list and none of them can
 * derive it: the harness dispatches on it, the composer highlights it, and
 * the transcript renders it as a chip. Kept in one file after the renderer's
 * private copy went stale and /compact, /clear and /tools stopped being
 * recognised as commands at all.
 */

/** What a surface with pickers offers for a command's argument as it is typed. */
export type CommandPick = "chat" | "job" | "approval";

/** A command's argument, as a surface with typed options (Discord's slash commands) takes it. */
export interface CommandOption {
  name: string;
  description: string;
  required?: boolean;
  /** Offered from what there is, as it is typed. */
  pick?: CommandPick;
  /** The only values it takes. */
  choices?: readonly string[];
}

export interface CommandSpec {
  name: string;
  /** Placeholder for what follows the command, where it takes something. */
  args?: string;
  description: string;
  /** Set when only the dashboard can do it; other surfaces say so. */
  where?: "dashboard";
  /** What follows the command, for a surface that asks for it as an option. */
  option?: CommandOption;
  /** Other names it answers to, registered as commands of their own where a surface keeps a list (Discord's slash commands). */
  aliases?: readonly string[];
}

const text = (name: string, description: string, required = false): CommandOption => ({ name, description, ...(required ? { required } : {}) });

/**
 * Every command a chat understands, once: the dashboard's composer, KOS for
 * Chrome and KOS for Mac offer these, the kernel runs them, and Discord
 * registers them as slash commands. A command added here is on every
 * surface; none keeps a list of its own.
 */
export const CHAT_COMMANDS: CommandSpec[] = [
  { name: "new", args: "[title]", description: "start another chat", option: text("title", "what it is for") },
  { name: "chats", description: "list your chats" },
  { name: "switch", args: "<number|title>", description: "move to one", option: { name: "chat", description: "which one", required: true, pick: "chat" }, aliases: ["target"] },
  { name: "here", description: "go back to this surface's own chat" },
  { name: "rename", args: "<title>", description: "rename this chat", option: text("title", "the new title", true) },
  { name: "fork", args: "[title]", description: "copy this chat, history and all, and move to the copy", option: text("title", "what to call the copy") },
  { name: "archive", description: "close this chat" },
  { name: "retry", description: "ask the last message again" },
  { name: "stop", description: "stop the turn running here" },
  { name: "mode", args: "[ask|auto]", description: "show or set whether KOS asks before risky steps here", option: { name: "mode", description: "ask, or auto", choices: ["ask", "auto"] } },
  { name: "brief", args: "[text]", description: "show or set this chat's standing instructions", option: text("text", "the instructions; - clears them") },
  { name: "agent", args: "[title]", description: "start an agent in this project and move to it", option: text("title", "what it is for") },
  { name: "agents", description: "list this project's agents and what they are doing" },
  { name: "dispatch", args: "<agent>: <task>", description: "hand a task to an agent", option: text("task", "<agent>: <task>", true) },
  { name: "project", args: "<name>", description: "stand up a project with its orchestrator", option: text("name", "the project's name", true) },
  { name: "inbox", description: "what is waiting on you, to approve or deny" },
  { name: "approve", args: "[#]", description: "approve what this chat is waiting on", option: { name: "id", description: "which ask", pick: "approval" } },
  { name: "deny", args: "[#]", description: "deny it", option: { name: "id", description: "which ask", pick: "approval" } },
  { name: "status", description: "what is running, and what is waiting on you" },
  { name: "run", args: "<job>", description: "run a scheduled job now", option: { name: "job", description: "which job", required: true, pick: "job" } },
  { name: "halt", description: "throw the kill switch: nothing runs until /resume" },
  { name: "resume", description: "lift the kill switch" },
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
