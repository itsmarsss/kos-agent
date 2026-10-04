import { primarySessionId, type Kernel } from "@kos/harness";

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
  start [--foreground] multi-modal host (API + cron + Discord if configured)
  stop                 stop the background host
  restart              stop then start; run pnpm build first to pick up code changes
  service <install|uninstall|status>  run the host as a launchd agent (macOS)
  chat                 REPL (attaches to host if running; default)
  once <message>       one message (via host if running)
  status               crons, queue, kill switch, pending, host info
  approvals | approve | deny | halt | resume
  crons | snapshot | clear | memory | pages
  doctor               preflight checks
  eval memory [--agent] [--json]  score memory reading on the golden set; --agent runs the kos.memory job itself
  serve                alias: host in foreground (API; Discord optional)
  discord              alias: host in foreground, require Discord
  help

Flags:
  --workspace <path>   workspace (default ~/kos-workspace or KOS_WORKSPACE)
  --host <addr>        host bind (default 127.0.0.1)
  --port <n>           host port (default 4317 or KOS_PORT)
  --sites-port <n>     port for serving built sites (default port+1, 0 off)
  --foreground / --fg  keep host in this terminal
  --no-discord         start host without Discord
  --discord            require Discord credentials

Typical flow:
  kos start            # background host + Discord if .env set
  kos                  # attach REPL (same session as Discord DMs)
  kos restart          # after changing config or rebuilding
  kos stop

Chat needs ANTHROPIC_API_KEY or OPENAI_API_KEY in .env.`;

export function statusLine(kernel: Kernel): string {
  const crons = kernel.crons.list().length;
  const pending = kernel.approvals.pending().length;
  // The routing table is picked from whichever API keys are present, so a
  // workspace with one provider gets a different agent from the default and
  // nothing said which one was answering.
  const reasoning = kernel.routes()?.["reasoning"];
  return [
    `kill switch: ${kernel.killSwitch.halted ? "HALTED" : "running"}`,
    `queue depth: ${kernel.queue.depth}`,
    `crons: ${crons}`,
    `pending approvals: ${pending}`,
    `projects: ${kernel.manifest.list().length}`,
    `pages: ${kernel.pages.list().length}`,
    ...(reasoning ? [`model: ${reasoning.model}`] : []),
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
      return res.reply ?? res.message;
    }

    case "deny": {
      const id = Number(rest[0]);
      if (!Number.isInteger(id)) return "usage: deny <id>";
      const res = await kernel.deny(id);
      return res.reply ?? res.message;
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

    case "clear": {
      const sessionId = rest[0] ?? primarySessionId(kernel.profile.ownerId);
      kernel.clearSession(sessionId);
      return `cleared session ${sessionId}`;
    }

    case "memory": {
      const facts = kernel.facts.all(kernel.profile.ownerId).slice(0, 20);
      if (facts.length === 0) return "no durable facts yet";
      return facts.map((f) => `(${f.kind}) ${f.key}: ${f.value}`).join("\n");
    }

    case "pages": {
      const list = kernel.pages.list();
      if (list.length === 0) return "no pages";
      return list
        .map((p) => `${p.id} [${p.projectSlug}] ${p.title}`)
        .join("\n");
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
  "clear",
  "memory",
  "pages",
  "doctor",
]);
