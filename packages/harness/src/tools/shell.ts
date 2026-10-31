import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { MAINTENANCE } from "../kernel/caretaker.js";
import type { KosModule, ModuleContext } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";
import { isReadOnlyCommand } from "../risk/readonly.js";
import { runCaptured, type CapturedRun } from "../sandbox/capture.js";
import { childEnv } from "../sandbox/env.js";
import { jailedCommand } from "../sandbox/jail.js";

/**
 * shell.run: a command, in the workspace, jailed.
 *
 * The one tool the spec calls optional and risky by floor. It runs where
 * the other tools can reach and nowhere else: the working directory is
 * resolved through the path jail, the environment is the allow-list every
 * child gets with HOME pointed at the workspace, and the process itself is
 * confined by the platform's sandbox (see sandbox/jail.ts). It asks every
 * time, or runs under a permission the owner remembered for that program.
 */

export interface ShellModuleOptions {
  /** Longest a command may run, in seconds. */
  timeoutSeconds?: number;
  /** Longest stdout or stderr kept, in characters. */
  maxOutput?: number;
}

export const SHELL_TIMEOUT_SECONDS = 120;
export const SHELL_MAX_OUTPUT = 20_000;

/** The workspace database named on a command line: the shell's road around the sql fence. */
export function namesDatabase(command: string): boolean {
  return /kos\.sqlite/.test(command);
}

/** Said to a chat that reached for the database with the shell, instead of asking the owner. */
export const DATABASE_REFUSED =
  "kos.sqlite is KOS's own database, not a file for the shell to open. What it holds is read through the tools for the job: " +
  "cron.list for jobs, chats.list and chats.read for chats, tasks.list, blobs.list, memory.recall for what KOS knows, discord.threads for threads; " +
  "your project's own tables through sql.";

export type ShellResult = CapturedRun;

export function runShell(
  command: string,
  opts: { workspaceRoot: string; cwd: string; timeoutMs: number; maxOutput: number },
): Promise<ShellResult> {
  const tmp = join(opts.workspaceRoot, ".kos", "tmp");
  mkdirSync(tmp, { recursive: true });
  return runCaptured(jailedCommand(command, { workspaceRoot: opts.workspaceRoot }), {
    cwd: opts.cwd,
    env: childEnv({ home: opts.workspaceRoot, tmp }),
    timeoutMs: opts.timeoutMs,
    maxOutput: opts.maxOutput,
  });
}

export function createShellModule(options: ShellModuleOptions = {}): KosModule {
  const timeoutSeconds = options.timeoutSeconds ?? SHELL_TIMEOUT_SECONDS;
  const maxOutput = options.maxOutput ?? SHELL_MAX_OUTPUT;
  return {
    manifest: {
      name: "shell",
      version: "1.0.0",
      provides: [{ kind: "tool", name: "shell.run", version: "1.0.0" }],
      riskTier: "risky",
    },
    activate(ctx: ModuleContext) {
      const ws = requireServices(ctx).workspace;
      ctx.registerTool(
        {
          name: "shell.run",
          description:
            "Run a shell command inside the workspace: git, pnpm, a build, a program. It cannot see the owner's home directory or write outside the workspace. Prefer the files, search and sql tools when one does the job, and python.run for a calculation or a short Python script, which runs at once without asking; use this for programs. " +
            "A command line that only reads (ls, cat, grep, find, git status/log/diff, and the like, joined by pipes or &&) runs without asking; anything that writes, runs code or reaches the network asks the owner first. Output is capped; long runs time out. " +
            "kos.sqlite, KOS's own database, is refused here, not asked about: jobs, chats, tasks, blobs and memory are read through cron.list, chats.list, tasks.list, blobs.list and memory.recall.",
          inputSchema: {
            type: "object",
            properties: {
              command: { type: "string", description: "the command line, run by /bin/sh" },
              cwd: { type: "string", description: "workspace-relative directory to run in; the workspace root by default" },
              timeout: { type: "number", description: `seconds before it is killed (default ${timeoutSeconds})` },
            },
            required: ["command"],
          },
        },
        async (input) => {
          const command = typeof input["command"] === "string" ? input["command"].trim() : "";
          if (!command) throw new Error("command is required");
          const cwdRel = typeof input["cwd"] === "string" && input["cwd"].trim() ? input["cwd"].trim() : ".";
          const cwd = ws.resolve(cwdRel);
          const seconds = typeof input["timeout"] === "number" && input["timeout"] > 0 ? Math.min(input["timeout"], 3600) : timeoutSeconds;
          const result = await runShell(command, { workspaceRoot: ws.root, cwd, timeoutMs: seconds * 1000, maxOutput: maxOutput });
          return JSON.stringify(result);
        },
        // Risky by floor, as the spec says; a line that provably only reads
        // runs as safe, since asking for every ls teaches the owner to say yes.
        // A line that opens KOS's own database is refused outright, as the
        // sql tool refuses those tables: asked, the owner said yes to a read
        // of the crons table twice in a day, each time to a chat that had
        // cron.list. Maintenance, which repairs KOS, may, and asks as for any
        // command that writes.
        {
          floor: "risky",
          why: "a command that may write",
          relax: (input) => typeof input["command"] === "string" && isReadOnlyCommand(input["command"]),
          refuse: (input) =>
            typeof input["command"] === "string" && namesDatabase(input["command"]) && ctx.services?.callerProject?.() !== MAINTENANCE.slug ? DATABASE_REFUSED : false,
        },
      );
    },
  };
}
