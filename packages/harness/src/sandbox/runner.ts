import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";

import { RESERVED } from "../kernel/files.js";
import { childEnv } from "./env.js";
import { runCaptured } from "./capture.js";
import { jailedProgram, type JailOptions } from "./jail.js";
import { resolvePath } from "../jail/resolvePath.js";
import { DB_FILENAME } from "../store/workspace.js";
import { snapshotDatabase } from "./snapshot.js";

/** Where the jail comes from: the platform's sandbox, or the container the host runs in. Tests name it. */
export type SkillJail = Pick<JailOptions, "contained" | "platform" | "homes" | "bubblewrap">;

export interface SandboxOptions {
  /** Absolute workspace root; the entry path is jailed against it. */
  workspaceRoot: string;
  /** Workspace-relative path to the script to run, in a skill's own folder. */
  entry: string;
  /** Extra argv passed to the script. */
  args?: string[];
  /** Wall-clock cap; on expiry the child is killed and timedOut is set. */
  timeoutMs?: number;
  jail?: SkillJail;
}

export interface SandboxResult {
  /** True only when the child exited 0 and did not time out. */
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** Longest stdout or stderr kept from a skill, in characters. */
export const SKILL_MAX_OUTPUT = 100_000;

/**
 * The folder node runs from, which a jailed skill must read to start at all:
 * under the owner's home when node came from nvm, and so denied otherwise.
 */
export function nodeReads(): string[] {
  return [dirname(dirname(realpathSync(process.execPath)))];
}

/** KOS's own state and settings, and a .env the host may have been started beside: never read by a skill on test. */
export function unreadByTest(root: string): string[] {
  return [...RESERVED, ".env"].map((name) => join(root, name));
}

/** A jailed node program, run to its end or its timeout in a process group of its own, output capped. */
export async function runJailedNode(
  entry: string,
  args: string[],
  run: { cwd: string; env: Record<string, string>; timeoutMs: number; jail: JailOptions },
): Promise<SandboxResult> {
  // Throws where there is no jail: such a skill is refused, never run on the host unconfined.
  const command = jailedProgram(process.execPath, [entry, ...args], run.jail);
  try {
    const ran = await runCaptured(command, { cwd: run.cwd, env: run.env, timeoutMs: run.timeoutMs, maxOutput: SKILL_MAX_OUTPUT });
    return { ok: ran.exitCode === 0 && !ran.timedOut, exitCode: ran.exitCode, signal: null, stdout: ran.stdout, stderr: ran.stderr, timedOut: ran.timedOut };
  } catch (err) {
    return { ok: false, exitCode: null, signal: null, stdout: "", stderr: String(err), timedOut: false };
  }
}

/**
 * Run an agent-written skill in isolation: a separate child process in the
 * jail, with no network, no reach past the sandbox (sealed), and writes
 * only to a scratch folder holding a copy of the skill and a throwaway copy
 * of the workspace DB (KOS_DB). Effects run dry (KOS_DRY_RUN), which the
 * jail, not the script's good manners, makes so. The live DB and KOS's
 * own files are not even readable. With no jail on this machine it is
 * refused: the throw says how to get one.
 */
export async function runSandbox(options: SandboxOptions): Promise<SandboxResult> {
  const entryAbs = resolvePath(options.workspaceRoot, options.entry);
  const liveDb = resolvePath(options.workspaceRoot, DB_FILENAME);
  const skillDir = dirname(entryAbs);
  if (relative(options.workspaceRoot, skillDir) === "") throw new Error("a skill runs from its own folder, not the workspace root");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "kos-sandbox-")));
  const dbCopy = join(tmp, DB_FILENAME);
  const copy = join(tmp, "skill");

  try {
    await snapshotDatabase(liveDb, dbCopy);
    // A scratch copy, so whatever the skill writes beside itself is thrown away with it.
    cpSync(skillDir, copy, { recursive: true, verbatimSymlinks: true });
    return await runJailedNode(join(copy, basename(entryAbs)), options.args ?? [], {
      cwd: copy,
      // An allow-list, not the host's environment: see childEnv.
      env: childEnv({ home: tmp, tmp }, { KOS_SANDBOX: "1", KOS_DRY_RUN: "1", KOS_DB: dbCopy }),
      timeoutMs,
      jail: {
        workspaceRoot: options.workspaceRoot,
        writes: [tmp],
        hidden: unreadByTest(options.workspaceRoot),
        reads: nodeReads(),
        network: false,
        sealed: true,
        ...options.jail,
      },
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
