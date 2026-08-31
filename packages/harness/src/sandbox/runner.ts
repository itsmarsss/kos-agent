import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { childEnv } from "./env.js";
import { resolvePath } from "../jail/resolvePath.js";
import { DB_FILENAME } from "../store/workspace.js";
import { snapshotDatabase } from "./snapshot.js";

export interface SandboxOptions {
  /** Absolute workspace root; the entry path is jailed against it. */
  workspaceRoot: string;
  /** Workspace-relative path to the script to run. */
  entry: string;
  /** Extra argv passed to the script. */
  args?: string[];
  /** Wall-clock cap; on expiry the child is killed and timedOut is set. */
  timeoutMs?: number;
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

/**
 * Run an agent-written skill in isolation: a separate child process, a
 * throwaway copy of the workspace DB (KOS_DB), and dry-run effects (KOS_DRY_RUN)
 * so external-effect tools mock instead of acting. The entry script is jailed
 * to the workspace. A failing or hanging skill cannot touch the live DB.
 */
export async function runSandbox(
  options: SandboxOptions,
): Promise<SandboxResult> {
  const entryAbs = resolvePath(options.workspaceRoot, options.entry);
  const liveDb = resolvePath(options.workspaceRoot, DB_FILENAME);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const tmp = mkdtempSync(join(tmpdir(), "kos-sandbox-"));
  const dbCopy = join(tmp, DB_FILENAME);

  try {
    await snapshotDatabase(liveDb, dbCopy);

    return await new Promise<SandboxResult>((resolve) => {
      const child = spawn(process.execPath, [entryAbs, ...(options.args ?? [])], {
        cwd: tmp,
        // An allow-list, not the host's environment: see childEnv.
        env: childEnv(
          { home: tmp, tmp },
          { KOS_SANDBOX: "1", KOS_DRY_RUN: "1", KOS_DB: dbCopy },
        ),
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          ok: false,
          exitCode: null,
          signal: null,
          stdout,
          stderr: stderr + String(err),
          timedOut,
        });
      });

      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({
          ok: code === 0 && !timedOut,
          exitCode: code,
          signal,
          stdout,
          stderr,
          timedOut,
        });
      });
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
