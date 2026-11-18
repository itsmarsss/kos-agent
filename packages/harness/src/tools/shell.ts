import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { guestOrigin, turnStop } from "../kernel/caller.js";
import { MAINTENANCE } from "../kernel/caretaker.js";
import { RESERVED } from "../kernel/files.js";
import type { KosModule, ModuleContext } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";
import { isReadOnlyCommand } from "../risk/readonly.js";
import { runCaptured, stopOf, type CapturedRun } from "../sandbox/capture.js";
import { childEnv } from "../sandbox/env.js";
import { isContained, jailedCommand } from "../sandbox/jail.js";
import { homeDirs, INTO_ANOTHER, placeFor, reachOutside, writeScope } from "./home.js";

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
  return /kos\.sqlite/i.test(folded(command));
}

/**
 * A command line as a case-folding disk reads names: compatibility forms
 * folded (the long s, ſ, is an s) and lower case. Only for the courtesy
 * refusals; the sandbox is what holds, and it folds names itself.
 */
function folded(command: string): string {
  return command.normalize("NFKC").toLowerCase();
}

/** KOS's database and its journals, which a command run for anyone but Maintenance cannot read at all. */
const DATABASE_FILES = ["kos.sqlite", "kos.sqlite-wal", "kos.sqlite-shm"];

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
  return /(^|[\s;&|<>()'"`=])(\.\/)?(mcp|profile|daemon)\.json\b/i.test(folded(command));
}

/** Said to a chat that reached for the harness's settings with the shell. */
export const CONFIG_REFUSED =
  "mcp.json, profile.json and daemon.json are KOS's own settings, which the shell does not touch: read one with files.read. The owner changes them from the dashboard or the kos command.";

/** The workspace's own top-level entries no command may write; .kos stays writable, as the shell's TMPDIR is inside it. */
const UNWRITTEN = [...RESERVED].filter((name) => name !== ".kos");

export type ShellResult = CapturedRun;

/** Asked for by name to let a project's or a blob's command write past its own folder. */
export const WIDE_WRITES = "workspace";

/** True when the call asks to write anywhere in the workspace. */
function wide(input: Record<string, unknown>): boolean {
  return input["writes"] === WIDE_WRITES;
}

/**
 * Where a project's or a blob's command keeps its tools' caches: its home's
 * own cache folder. HOME is the workspace root, which such a command may not
 * write, so pip, npm, Go, Cargo and anything that follows XDG would fail to
 * cache or install for the user; and a cache is code the next run loads, so
 * none is shared with another home.
 */
export function cacheEnv(cache: string): Record<string, string> {
  return {
    XDG_CACHE_HOME: cache,
    npm_config_cache: join(cache, "npm"),
    PIP_CACHE_DIR: join(cache, "pip"),
    PYTHONUSERBASE: join(cache, "python"),
    GOCACHE: join(cache, "go", "build"),
    GOMODCACHE: join(cache, "go", "mod"),
    CARGO_HOME: join(cache, "cargo"),
  };
}

export function runShell(
  command: string,
  opts: { workspaceRoot: string; cwd: string; timeoutMs: number; maxOutput: number; signal?: AbortSignal; writes?: string[]; hidden?: string[]; dirs?: { tmp: string; cache: string } },
): Promise<ShellResult> {
  // A home's own temp and caches, or the workspace's shared temp at the root.
  const tmp = opts.dirs?.tmp ?? join(opts.workspaceRoot, ".kos", "tmp");
  for (const dir of [tmp, ...(opts.dirs ? [opts.dirs.cache] : [])]) mkdirSync(dir, { recursive: true });
  const readOnly = UNWRITTEN.map((name) => join(opts.workspaceRoot, name));
  return runCaptured(jailedCommand(command, { workspaceRoot: opts.workspaceRoot, readOnly, ...(opts.writes ? { writes: opts.writes } : {}), ...(opts.hidden ? { hidden: opts.hidden } : {}) }), {
    cwd: opts.cwd,
    env: childEnv({ home: opts.workspaceRoot, tmp }, opts.dirs ? cacheEnv(opts.dirs.cache) : {}),
    timeoutMs: opts.timeoutMs,
    maxOutput: opts.maxOutput,
    ...stopOf(opts.signal),
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
      const cwdReach = reachOutside(ws, ctx, (input) => [input["cwd"]]);
      ctx.registerTool(
        {
          name: "shell.run",
          description:
            "Run a shell command inside the workspace: git, pnpm, a build, a program. It cannot see the owner's home directory or write outside the workspace. Prefer the files, search and sql tools when one does the job, and python.run for a calculation or a short Python script, which runs at once without asking; use this for programs. " +
            "A command line that only reads (ls, cat, grep, find, git status/log/diff, and the like, joined by pipes or &&) runs without asking; anything that writes, runs code or reaches the network asks the owner first. Output is capped; long runs time out. " +
            `In a project's or a blob's chat it writes only in your own folder and scratch/; writes: "${WIDE_WRITES}" lets it write anywhere in the workspace, which the owner is asked for by name. ` +
            "kos.sqlite, KOS's own database, is refused here, not asked about: jobs, chats, tasks, blobs and memory are read through cron.list, chats.list, tasks.list, blobs.list and memory.recall.",
          inputSchema: {
            type: "object",
            properties: {
              command: { type: "string", description: "the command line, run by /bin/sh" },
              cwd: {
                type: "string",
                description: "directory to run in: your own folder by default (your project's, or the workspace at the root), and a relative one inside it; workspace:<path> is from the workspace root. ~ is the workspace root.",
              },
              timeout: { type: "number", description: `seconds before it is killed (default ${timeoutSeconds})` },
              writes: { type: "string", enum: [WIDE_WRITES], description: "only to write outside your own folder and scratch/: asks the owner for the whole workspace" },
            },
            required: ["command"],
          },
        },
        async (input) => {
          const command = typeof input["command"] === "string" ? input["command"].trim() : "";
          if (!command) throw new Error("command is required");
          const asked = typeof input["cwd"] === "string" && input["cwd"].trim() ? input["cwd"].trim() : undefined;
          const cwd = placeFor(ws, ctx, asked ?? ".").abs;
          // The turn's own folder is made if the project has written nothing yet; a folder asked for must be there.
          if (asked === undefined) mkdirSync(cwd, { recursive: true });
          const seconds = typeof input["timeout"] === "number" && input["timeout"] > 0 ? Math.min(input["timeout"], 3600) : timeoutSeconds;
          // A project's or a blob's command writes in its own folders unless the owner allowed the whole workspace by name.
          const narrowed = writeScope(ws, ctx);
          const writes = wide(input) ? undefined : narrowed;
          // A project's or a blob's own temp and caches, even when it may write the whole workspace.
          const dirs = narrowed ? homeDirs(ws, ctx) : undefined;
          for (const dir of writes ?? []) mkdirSync(dir, { recursive: true });
          // The database is unreadable to every command but Maintenance's own, whatever spelling or glob names it.
          const repairs = ctx.services?.callerProject?.() === MAINTENANCE.slug && guestOrigin() === undefined;
          const hidden = repairs ? undefined : DATABASE_FILES.map((name) => join(ws.root, name));
          const result = await runShell(command, { workspaceRoot: ws.root, cwd, timeoutMs: seconds * 1000, maxOutput: maxOutput, ...stopOf(turnStop.getStore()), ...(writes ? { writes } : {}), ...(hidden ? { hidden } : {}), ...(dirs ? { dirs } : {}) });
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
          // In the container nothing narrower than the container holds a project's command to its folder, and the card says so.
          why: () => (isContained() && writeScope(ws, ctx) ? "a command that may write anywhere in the workspace: only the container holds it" : "a command that may write"),
          relax: (input) => typeof input["command"] === "string" && isReadOnlyCommand(input["command"]),
          // Writing the whole workspace is its own ask, beyond Auto; run somewhere outside the turn's own folder, the card says where.
          reach: (input) => (wide(input) && writeScope(ws, ctx) ? { why: "may write anywhere in the workspace", beyondAuto: INTO_ANOTHER } : cwdReach(input)),
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
