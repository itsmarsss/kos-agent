import { spawn } from "node:child_process";

import type { JailedCommand } from "./jail.js";

/** What a jailed program said, and how it ended. */
export interface CapturedRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  /** Ended because the turn running it was stopped. */
  stopped?: true;
  /** Git control the run planted, moved to .kos/quarantine: see gitwatch.ts. */
  quarantined?: string[];
  /** Planted git control that could not be taken away: the owner must remove it, and unapproved runs there are refused. */
  quarantineFailed?: string[];
  /** Undoing the jail after the run failed; the run's own result stands beside it. */
  releaseFailed?: string;
}

export interface CaptureOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  /** Longest stdout or stderr kept, in characters. */
  maxOutput: number;
  /** Ends the program at once, with what it printed so far. */
  signal?: AbortSignal;
}

/** The stop option, when there is a stop: spread into CaptureOptions. */
export function stopOf(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal ? { signal } : {};
}

/**
 * Run a program to the end, to its timeout or to a stop, keeping what it
 * printed up to a cap.
 *
 * It leads a process group of its own, and ending it ends the group: a shell
 * killed alone left the `sleep` it had started running on behind it.
 * Whatever jailing it put in place is released when it ends.
 */
export function runCaptured(command: JailedCommand, opts: CaptureOptions): Promise<CapturedRun> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command.file, command.args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (err) {
      try {
        command.release?.();
      } catch {
        // The spawn's own error is the one to report.
      }
      reject(err);
      return;
    }
    const end = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const keep = (current: string, chunk: Buffer): string => {
      if (current.length >= opts.maxOutput) {
        truncated = true;
        return current;
      }
      const next = current + chunk.toString("utf8");
      if (next.length > opts.maxOutput) {
        truncated = true;
        return next.slice(0, opts.maxOutput);
      }
      return next;
    };
    child.stdout.on("data", (c: Buffer) => { stdout = keep(stdout, c); });
    child.stderr.on("data", (c: Buffer) => { stderr = keep(stderr, c); });
    let timedOut = false;
    let stopped = false;
    const timer = setTimeout(() => {
      timedOut = true;
      end();
    }, opts.timeoutMs);
    const onStop = (): void => {
      stopped = true;
      end();
    };
    if (opts.signal?.aborted) onStop();
    else opts.signal?.addEventListener("abort", onStop, { once: true });
    let after: Partial<CapturedRun> = {};
    // Whatever the release does, the run settles: a throw there is put in the result, never left to hang the call.
    const settle = (): void => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onStop);
      try {
        const released = command.release?.();
        after = {
          ...(released?.quarantined.length ? { quarantined: released.quarantined } : {}),
          ...(released?.quarantineFailed.length ? { quarantineFailed: released.quarantineFailed } : {}),
        };
      } catch (err) {
        after = { releaseFailed: err instanceof Error ? err.message : String(err) };
      }
    };
    child.on("error", (err) => {
      settle();
      reject(err);
    });
    child.on("close", (code) => {
      settle();
      const warning = after.quarantineFailed
        ? `\nKOS: git control this run planted could not be removed (${after.quarantineFailed.join(", ")}): tell the owner to delete it; commands nobody approved are refused there until then.`
        : after.releaseFailed
          ? `\nKOS: undoing the jail after this run failed: ${after.releaseFailed}`
          : "";
      resolve({ exitCode: code, stdout, stderr: stderr + warning, timedOut, truncated, ...(stopped ? { stopped: true as const } : {}), ...after });
    });
  });
}
