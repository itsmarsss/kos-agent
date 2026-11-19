import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { guestOrigin, turnStop, underAuto } from "../kernel/caller.js";
import { MAINTENANCE } from "../kernel/caretaker.js";
import { foldName, RESERVED } from "../kernel/files.js";
import type { KosModule, ModuleContext } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";
import { CONTAINED_BEYOND_AUTO, destructiveCommand } from "../risk/beyondauto.js";
import { readOnlyLine } from "../risk/readonly.js";
import { shellBeyondAuto } from "../risk/shellauto.js";
import { runCaptured, stopOf, type CapturedRun } from "../sandbox/capture.js";
import { childEnv } from "../sandbox/env.js";
import { GIT_CONTROL_WRITES, GIT_INFO_ATTRIBUTES, gitGlobalConfig, gitHeldOn, gitHoldEnv } from "../sandbox/githold.js";
import { isContained, jailedCommand, kosSecretFiles, type JailOptions } from "../sandbox/jail.js";
import { outsideScratch } from "./files.js";
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
  /** The host runs in the container, which is the jail: whether it does by default. */
  contained?: boolean;
}

export const SHELL_TIMEOUT_SECONDS = 120;
export const SHELL_MAX_OUTPUT = 20_000;

/** The workspace database named on a command line: the shell's road around the sql fence. */
export function namesDatabase(command: string): boolean {
  return /kos\.sqlite/i.test(foldName(command));
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
  return /(^|[\s;&|<>()'"`=])(\.\/)?(mcp|profile|daemon)\.json\b/i.test(foldName(command));
}

/** Said to a chat that reached for the harness's settings with the shell. */
export const CONFIG_REFUSED =
  "mcp.json, profile.json and daemon.json are KOS's own settings, which no tool reads or writes. The owner changes them from the dashboard or the kos command.";

/**
 * What a command in the container may not name, until its tools run as a
 * user of their own: /proc, whose environ files hold the env the container
 * was started with (provider keys, the vault key, the dashboard token), and
 * KOS's own home, its keys and the vault, which the one user shares.
 */
export function namesContainerSecret(command: string, secrets: readonly string[] = [homedir(), ...kosSecretFiles()]): boolean {
  const folded = foldName(command);
  const named = (path: string): boolean => new RegExp(`(^|[^\\w.-])${escapeRegex(foldName(path.replace(/\/+$/, "")))}(?![\\w.-])`).test(folded);
  return ["/proc", ...secrets].some(named);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Said to a chat whose command in the container named /proc, KOS's home or the vault. */
export const CONTAINER_SECRET_REFUSED =
  "In the container a command does not read /proc, KOS's home folder or the secrets vault: they hold the keys KOS was started with. Work in the workspace.";

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

/**
 * What a read-only run may not read although it is in the workspace: KOS's
 * own state and settings, and a .env the host may have been started beside.
 */
const UNREAD = [...RESERVED, ".env"];

/**
 * The jail of a line a chat's Auto let run. It writes where an approved run
 * of its home would, and no further: none of KOS's own state but its temp
 * and caches, no .env, no repository's config or hooks and no git global
 * config, where a planted program would run on the owner's next approved
 * git command. It reads none of KOS's settings or a .env, reaches this
 * machine's loopback and nothing past it, and is sealed: no app opened, no
 * other process signalled, no preference written.
 */
function autoJail(root: string, writes: string[] | undefined, hidden: string[] | undefined): JailOptions {
  const kos = join(root, ".kos");
  return {
    workspaceRoot: root,
    ...(writes ? { writes } : {}),
    hidden: [...UNREAD.filter((name) => name !== ".kos").map((name) => join(root, name)), ...(hidden ?? [])],
    readOnly: [...UNWRITTEN.map((name) => join(root, name)), kos, join(root, ".env"), ...gitGlobalConfig(root)],
    writableWithin: [join(kos, "tmp"), join(kos, "cache")],
    unwritable: GIT_CONTROL_WRITES,
    unreadable: [GIT_INFO_ATTRIBUTES],
    network: "local",
    sealed: true,
  };
}

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
     * approved writes the workspace, or only the folders in writes.
     */
    readOnlyRun?: boolean;
    /** Where an approved run may write: a project's or a blob's own folders; the whole workspace when absent. */
    writes?: string[];
    /** Paths no run may read, read-only or approved. */
    hidden?: string[];
    /** A home's own temp and caches, in place of the workspace's shared temp. */
    dirs?: { tmp: string; cache: string };
    /**
     * True for a line a chat's Auto let run unasked. It writes as an
     * approved run does (Auto must be able to build), but the jail, not the
     * list of programs, is the boundary: this machine's network only, git
     * held as for a read-only run, and no reach past the sandbox (sealed).
     */
    auto?: boolean;
  },
): Promise<ShellResult> {
  // A home's own temp and caches, or the workspace's shared temp at the root; a read-only run's fresh temp inside it.
  const shared = opts.dirs?.tmp ?? join(opts.workspaceRoot, ".kos", "tmp");
  for (const dir of [shared, ...(opts.dirs ? [opts.dirs.cache] : [])]) mkdirSync(dir, { recursive: true });
  const tmp = opts.readOnlyRun ? mkdtempSync(join(shared, "read-")) : shared;
  const jail = opts.readOnlyRun
    ? {
        workspaceRoot: opts.workspaceRoot,
        writes: [tmp],
        hidden: [...UNREAD.map((name) => join(opts.workspaceRoot, name)), ...(opts.hidden ?? [])],
        unreadable: [GIT_INFO_ATTRIBUTES],
        network: false,
        sealed: true,
      }
    : opts.auto
      ? autoJail(opts.workspaceRoot, opts.writes, opts.hidden)
      : {
          workspaceRoot: opts.workspaceRoot,
          readOnly: UNWRITTEN.map((name) => join(opts.workspaceRoot, name)),
          ...(opts.writes ? { writes: opts.writes } : {}),
          ...(opts.hidden ? { hidden: opts.hidden } : {}),
        };
  // A read-only run writes no cache; an approved one keeps its home's own.
  const extra: Record<string, string> = opts.readOnlyRun ? { NPM_CONFIG_UPDATE_NOTIFIER: "false" } : opts.dirs ? cacheEnv(opts.dirs.cache) : {};
  try {
    return await runCaptured(jailedCommand(command, jail), {
      cwd: opts.cwd,
      // Git's program-naming settings pinned (fsmonitor, pager, editors, gpg,
      // attributes); hooks and transport too for a run nobody approved, read-only or Auto's.
      env: gitHoldEnv(childEnv({ home: opts.workspaceRoot, tmp }, extra), { readOnly: opts.readOnlyRun === true || opts.auto === true }),
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
  const contained = options.contained ?? isContained();
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
      // A git line is a read only where the git a child finds can be held.
      const readOnly = (command: string): string | undefined => readOnlyLine(command, { gitHeld: gitHeldOn(childEnv({ home: ws.root }).PATH ?? "") });
      ctx.registerTool(
        {
          name: "shell.run",
          description:
            "Run a shell command inside the workspace: git, pnpm, a build, a program. It cannot see the owner's home directory or write outside the workspace. Prefer the files, search and sql tools when one does the job, and python.run for a calculation or a short Python script, which runs at once without asking; use this for programs. " +
            (contained
              ? "Every command asks the owner first, even one that only reads: nothing narrower than the container holds it. "
              : "A command line that only reads (ls, cat, grep, find, git status/log/diff, and the like, joined by pipes or &&) runs without asking, offline and unable to write; anything that writes, runs code or reaches the network asks the owner first. ") +
            "To see a project's packages, read package.json with files.read; pnpm and yarn ask. Output is capped; long runs time out. " +
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
          // A line judged read-only ran unasked, so it runs where the judgement cannot matter, as the line that judgement gives.
          const line = readOnly(command);
          const result = await runShell(line ?? command, { workspaceRoot: ws.root, cwd, timeoutMs: seconds * 1000, maxOutput, readOnlyRun: line !== undefined, ...stopOf(turnStop.getStore()), ...(line === undefined && underAuto.getStore() ? { auto: true } : {}), ...(writes ? { writes } : {}), ...(hidden ? { hidden } : {}), ...(dirs ? { dirs } : {}) });
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
          // In the container a read-only line has no jail narrower than the container, so it asks as any line does.
          relax: (input) => !contained && typeof input["command"] === "string" && readOnly(input["command"]) !== undefined,
          // Writing the whole workspace is its own ask, beyond Auto; run somewhere outside the turn's own folder, the card says where.
          reach: (input) => (wide(input) && writeScope(ws, ctx) ? { why: "may write anywhere in the workspace", beyondAuto: INTO_ANOTHER } : cwdReach(input)),
          // What a chat's Auto runs unasked: only a line of reading and building programs (risk/shellauto.ts).
          // A line that destroys work says so first, as the reason the owner reads.
          beyondAuto: (input) => {
            if (contained) return CONTAINED_BEYOND_AUTO;
            const command = typeof input["command"] === "string" ? input["command"] : "";
            const asked = typeof input["cwd"] === "string" && input["cwd"].trim() ? input["cwd"].trim() : ".";
            // Where the line runs, from the workspace root, placed as the run places it: from the turn's home.
            let cwd: string;
            try {
              cwd = placeFor(ws, ctx, asked).rel || ".";
            } catch {
              return "runs in a folder the jail refuses";
            }
            // A file (not a folder) that is there outside scratch, by its path from the root: one the jail would not let the line reach is not there for it.
            const exists = (path: string): boolean => {
              try {
                return outsideScratch(path) && statSync(ws.resolve(path)).isFile();
              } catch {
                return false;
              }
            };
            // A target as the line names it, from the root: ~ and $HOME are the root, the child's home.
            const fromRoot = (path: string): string => {
              const home = /^(?:~|\$HOME|\$\{HOME\})(?:\/(.*))?$/.exec(path);
              return home ? home[1] || "." : join(cwd, path);
            };
            return destructiveCommand(command, (path) => exists(fromRoot(path)), (path) => !outsideScratch(fromRoot(path))) || shellBeyondAuto(command, exists, cwd);
          },
          refuse: (input) => {
            if (typeof input["command"] !== "string") return false;
            if (namesHarnessConfig(input["command"])) return CONFIG_REFUSED;
            if (contained && namesContainerSecret(input["command"])) return CONTAINER_SECRET_REFUSED;
            return namesDatabase(input["command"]) && (ctx.services?.callerProject?.() !== MAINTENANCE.slug || guestOrigin() !== undefined) ? DATABASE_REFUSED : false;
          },
        },
      );
    },
  };
}
