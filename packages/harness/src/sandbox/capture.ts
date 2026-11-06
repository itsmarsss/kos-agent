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
 */
export function runCaptured(command: JailedCommand, opts: CaptureOptions): Promise<CapturedRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
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
    const settle = (): void => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onStop);
    };
    child.on("error", (err) => {
      settle();
      reject(err);
    });
    child.on("close", (code) => {
      settle();
      resolve({ exitCode: code, stdout, stderr, timedOut, truncated, ...(stopped ? { stopped: true as const } : {}) });
    });
  });
}
