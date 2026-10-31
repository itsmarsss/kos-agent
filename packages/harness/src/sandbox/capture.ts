import { spawn } from "node:child_process";

import type { JailedCommand } from "./jail.js";

/** What a jailed program said, and how it ended. */
export interface CapturedRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

export interface CaptureOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  /** Longest stdout or stderr kept, in characters. */
  maxOutput: number;
}

/** Run a program to the end, or to its timeout, keeping what it printed up to a cap. */
export function runCaptured(command: JailedCommand, opts: CaptureOptions): Promise<CapturedRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
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
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut, truncated });
    });
  });
}
