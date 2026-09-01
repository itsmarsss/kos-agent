import { resolvePath } from "../jail/resolvePath.js";

/**
 * What a build sub-agent is allowed to do without asking.
 *
 * A Claude Code sub-agent is the most capable thing KOS can start and the
 * least bounded: it edits files and runs shell commands, and a shell command
 * has the whole host account, which resolvePath does not bound. So the
 * question this module answers is not "is this safe" but "is this inside the
 * corner of the workspace the owner pointed at, using a tool that cannot leave
 * it anyway".
 *
 * Everything else asks. That includes every shell command, because a shell is
 * exactly the thing the path jail cannot reason about: `cat ../../.ssh/id_rsa`
 * is one string to the filesystem tools and a full escape to bash.
 *
 * The decision is a pure function of the tool name, its input, and the scope
 * directory, so the rule can be tested without starting an agent.
 */

export type Decision =
  | { verdict: "allow" }
  | { verdict: "ask"; reason: string }
  | { verdict: "deny"; reason: string };

/**
 * Tools that only ever read, and only through a path argument. In scope they
 * are as harmless as the file browser; out of scope they are how a workspace
 * gets read out of, so the path still decides.
 */
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "NotebookRead"]);

/** Tools that change a file named by a path argument. */
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/**
 * Tools with no path and no reach: bookkeeping the sub-agent does with itself.
 * Nothing here touches the workspace or the network.
 */
const INERT_TOOLS = new Set(["TodoWrite", "TodoRead", "ExitPlanMode"]);

/** Where a tool keeps the path it is about to act on. */
const PATH_KEYS = ["file_path", "path", "notebook_path"];

/** Pull the path a tool is acting on, if it names one. */
export function pathArgument(input: Record<string, unknown>): string | undefined {
  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

/**
 * Whether a path lands inside the scope directory.
 *
 * The scope directory is used as the jail root, which is strictly stronger
 * than checking against the workspace: a build pointed at sites/tracker cannot
 * reach projects/, let alone the database. Traversal, absolute paths and
 * symlinks are all rejected by the gate rather than pattern-matched here.
 */
export function insideScope(scopeDir: string, candidate: string): boolean {
  try {
    resolvePath(scopeDir, candidate);
    return true;
  } catch {
    return false;
  }
}

export interface ScopeOptions {
  /** Absolute, symlink-free directory the build is confined to. */
  scopeDir: string;
  /**
   * Commands the owner has already approved for this build, matched exactly.
   * Approving `npm install` once should not mean approving it forty times.
   */
  allowedCommands?: ReadonlySet<string>;
}

/**
 * Decide what happens when the sub-agent asks to use a tool.
 *
 * Default is to ask, not to allow: an unrecognised tool is a tool whose
 * behaviour this function does not model, and guessing in the permissive
 * direction is how a jail becomes decorative.
 */
export function decide(
  tool: string,
  input: Record<string, unknown>,
  options: ScopeOptions,
): Decision {
  if (INERT_TOOLS.has(tool)) return { verdict: "allow" };

  if (READ_TOOLS.has(tool) || WRITE_TOOLS.has(tool)) {
    const path = pathArgument(input);
    // Grep and Glob default to the working directory, which is the scope.
    if (path === undefined) {
      return READ_TOOLS.has(tool)
        ? { verdict: "allow" }
        : { verdict: "ask", reason: `${tool} without a path` };
    }
    if (insideScope(options.scopeDir, path)) return { verdict: "allow" };
    return {
      verdict: "ask",
      reason: `${tool} on ${path}, which is outside the build's folder`,
    };
  }

  if (tool === "Bash" || tool === "BashOutput" || tool === "KillShell") {
    const command = typeof input.command === "string" ? input.command : "";
    if (command && options.allowedCommands?.has(command)) {
      return { verdict: "allow" };
    }
    // Every shell command asks. A shell is the one tool whose reach cannot be
    // read off its arguments: the path jail sees a string, and bash sees a
    // way out of the workspace.
    return { verdict: "ask", reason: command ? `run: ${command}` : "run a shell command" };
  }

  if (tool === "WebFetch" || tool === "WebSearch") {
    const target =
      typeof input.url === "string"
        ? input.url
        : typeof input.query === "string"
          ? input.query
          : "";
    return { verdict: "ask", reason: `reach the network: ${target || tool}` };
  }

  // A sub-agent starting its own sub-agents is a hole in the accounting: its
  // children's tool calls would not come back through this function.
  if (tool === "Task") {
    return { verdict: "deny", reason: "a build may not start further agents" };
  }

  return { verdict: "ask", reason: `use ${tool}, which KOS does not model` };
}
