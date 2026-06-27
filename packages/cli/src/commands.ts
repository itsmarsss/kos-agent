import type { Kernel } from "@kos/harness";

/**
 * CLI command dispatch, kept separate from IO so it is testable. Each command
 * takes the booted kernel and returns text to print. The REPL maps slash
 * commands (e.g. /status) to the same dispatch; argv subcommands use it too.
 */

export interface ParsedArgs {
  command: string;
  rest: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { command: positional[0] ?? "chat", rest: positional.slice(1), flags };
}

const HELP = `kos commands:
  chat                 interactive REPL (default)
  once <message>       run one message and print the reply
  status               crons, queue depth, kill switch, pending, last backup
  approvals            list pending risky actions
  approve <id>         approve and execute a pending action
  deny <id>            deny a pending action
  halt | resume        engage / release the kill switch
  crons                list scheduled jobs
  snapshot [message]   git-snapshot the workspace
  help                 this help

In the REPL, prefix any command with '/' (e.g. /status). Plain text is a message.`;

export function statusLine(kernel: Kernel): string {
  const crons = kernel.crons.list().length;
  const pending = kernel.approvals.pending().length;
  return [
    `kill switch: ${kernel.killSwitch.halted ? "HALTED" : "running"}`,
    `queue depth: ${kernel.queue.depth}`,
    `crons: ${crons}`,
    `pending approvals: ${pending}`,
  ].join(" | ");
}

/** Run a non-chat command. Returns text to print, or null for unknown. */
export async function runCommand(
  kernel: Kernel,
  command: string,
  rest: string[],
): Promise<string> {
  switch (command) {
    case "help":
      return HELP;

    case "status":
      return statusLine(kernel);

    case "approvals": {
      const pending = kernel.approvals.pending();
      if (pending.length === 0) return "no pending approvals";
      return pending
        .map((p) => `#${p.id} ${p.tool} ${p.args} (${p.reason ?? ""})`)
        .join("\n");
    }

    case "approve": {
      const id = Number(rest[0]);
      if (!Number.isInteger(id)) return "usage: approve <id>";
      const res = await kernel.approve(id);
      return res.message;
    }

    case "deny": {
      const id = Number(rest[0]);
      if (!Number.isInteger(id)) return "usage: deny <id>";
      return kernel.deny(id).message;
    }

    case "halt":
      kernel.killSwitch.halt();
      return "kill switch engaged; crons and self-prompts halted";

    case "resume":
      kernel.killSwitch.resume();
      return "kill switch released";

    case "crons": {
      const jobs = kernel.crons.list();
      if (jobs.length === 0) return "no scheduled jobs";
      return jobs
        .map((j) => `#${j.id} ${j.name} [${j.schedule}] ${j.type} ${j.enabled ? "" : "(disabled)"}`)
        .join("\n");
    }

    case "snapshot": {
      await kernel.backup.ensureRepo();
      const sha = await kernel.backup.snapshot(rest.join(" ") || undefined);
      return sha ? `snapshot ${sha.slice(0, 10)}` : "nothing to snapshot";
    }

    default:
      return `unknown command: ${command}\n${HELP}`;
  }
}

/** Commands that do not require a model (usable without an API key). */
export const OFFLINE_COMMANDS = new Set([
  "help",
  "status",
  "approvals",
  "approve",
  "deny",
  "halt",
  "resume",
  "crons",
  "snapshot",
]);
