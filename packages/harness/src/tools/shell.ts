import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { guestOrigin, turnStop } from "../kernel/caller.js";
import { MAINTENANCE } from "../kernel/caretaker.js";
import { RESERVED } from "../kernel/files.js";
import type { KosModule, ModuleContext } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";
import { isReadOnlyCommand } from "../risk/readonly.js";
import { runCaptured, stopOf, type CapturedRun } from "../sandbox/capture.js";
import { childEnv } from "../sandbox/env.js";
import { GIT_INFO_ATTRIBUTES, gitHeldOn, gitHoldEnv } from "../sandbox/githold.js";
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

/**
 * One of the harness's settings named at the workspace root on a command
 * line. Only a courtesy, so the chat is told why rather than shown a denied
 * write: the sandbox is what keeps these files unwritten, however a command
 * names them.
 */
export function namesHarnessConfig(command: string): boolean {
  return /(^|[\s;&|<>()'"`=])(\.\/)?(mcp|profile|daemon)\.json\b/i.test(command);
}

/** Said to a chat that reached for the harness's settings with the shell. */
export const CONFIG_REFUSED =
  "mcp.json, profile.json and daemon.json are KOS's own settings, which the shell does not touch: read one with files.read. The owner changes them from the dashboard or the kos command.";

/** The workspace's own top-level entries no command may write; .kos stays writable, as the shell's TMPDIR is inside it. */
const UNWRITTEN = [...RESERVED].filter((name) => name !== ".kos");

export type ShellResult = CapturedRun;

/**
 * What a read-only run may not read although it is in the workspace: KOS's
 * own state and settings, and a .env the host may have been started beside.
 */
const UNREAD = [...RESERVED, ".env"];

export async function runShell(
  command: string,
  opts: {
    workspaceRoot: string;
    cwd: string;
    timeoutMs: number;
    maxOutput: number;
    signal?: AbortSignal;
    /**
     * True for a line judged read-only, which runs without asking. The
     * judgement is a string's, so the run is made one that cannot matter
     * if it is wrong: no writes but its own temp folder, no network, none
     * of KOS's own files, git with no hooks or transport. A run the owner
     * approved writes the workspace as the shell always has.
     */
    readOnlyRun?: boolean;
  },
): Promise<ShellResult> {
  const shared = join(opts.workspaceRoot, ".kos", "tmp");
  mkdirSync(shared, { recursive: true });
  const tmp = opts.readOnlyRun ? mkdtempSync(join(shared, "read-")) : shared;
  const jail = opts.readOnlyRun
    ? {
        workspaceRoot: opts.workspaceRoot,
        writes: [tmp],
        hidden: UNREAD.map((name) => join(opts.workspaceRoot, name)),
        unreadable: [GIT_INFO_ATTRIBUTES],
        network: false,
      }
    : { workspaceRoot: opts.workspaceRoot, readOnly: UNWRITTEN.map((name) => join(opts.workspaceRoot, name)) };
  const extra: Record<string, string> = opts.readOnlyRun ? { NPM_CONFIG_UPDATE_NOTIFIER: "false" } : {};
  try {
    return await runCaptured(jailedCommand(command, jail), {
      cwd: opts.cwd,
      // Git's program-naming settings pinned (fsmonitor, pager, editors, gpg,
      // attributes); a read-only run's hooks and transport too.
      env: gitHoldEnv(childEnv({ home: opts.workspaceRoot, tmp }, extra), { readOnly: opts.readOnlyRun ?? false }),
      timeoutMs: opts.timeoutMs,
      maxOutput: opts.maxOutput,
      ...stopOf(opts.signal),
    });
  } finally {
    if (opts.readOnlyRun) rmSync(tmp, { recursive: true, force: true });
  }
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
      // A git line is a read only where the git a child finds can be held.
      const readsOnly = (command: string): boolean => isReadOnlyCommand(command, { gitHeld: gitHeldOn(childEnv({ home: ws.root }).PATH ?? "") });
      ctx.registerTool(
        {
          name: "shell.run",
          description:
            "Run a shell command inside the workspace: git, pnpm, a build, a program. It cannot see the owner's home directory or write outside the workspace. Prefer the files, search and sql tools when one does the job, and python.run for a calculation or a short Python script, which runs at once without asking; use this for programs. " +
            "A command line that only reads (ls, cat, grep, find, git status/log/diff, and the like, joined by pipes or &&) runs without asking, offline and unable to write; anything that writes, runs code or reaches the network asks the owner first. To see a project's packages, use npm ls or read package.json with files.read; pnpm and yarn ask. Output is capped; long runs time out. " +
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
          // A line judged read-only ran unasked, so it runs where the judgement cannot matter.
          const readOnlyRun = readsOnly(command);
          const result = await runShell(command, { workspaceRoot: ws.root, cwd, timeoutMs: seconds * 1000, maxOutput, readOnlyRun, ...stopOf(turnStop.getStore()) });
          return JSON.stringify(result);
        },
        // Risky by floor, as the spec says; a line that provably only reads
        // runs as safe, since asking for every ls teaches the owner to say yes.
        // A line that opens KOS's own database is refused outright, as the
        // sql tool refuses those tables: asked, the owner said yes to a read
        // of the crons table twice in a day, each time to a chat that had
        // cron.list. Maintenance, which repairs KOS, may, and asks as for any
        // command that writes, unless a guest's words started the work.
        {
          floor: "risky",
          why: "a command that may write",
          relax: (input) => typeof input["command"] === "string" && readsOnly(input["command"]),
          refuse: (input) => {
            if (typeof input["command"] !== "string") return false;
            if (namesHarnessConfig(input["command"])) return CONFIG_REFUSED;
            return namesDatabase(input["command"]) && (ctx.services?.callerProject?.() !== MAINTENANCE.slug || guestOrigin() !== undefined) ? DATABASE_REFUSED : false;
          },
        },
      );
    },
  };
}
