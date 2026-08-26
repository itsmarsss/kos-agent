import { spawn } from "node:child_process";

import { resolvePath } from "../jail/resolvePath.js";
import { DB_FILENAME } from "../store/workspace.js";
import type { SandboxResult } from "../sandbox/runner.js";

/**
 * Run a promoted skill for real: still a child process with a wall-clock cap,
 * but against the live database and with effects unmocked.
 *
 * This is the single most dangerous operation in KOS, which is why the tool
 * that calls it sits at a risky floor and can only ever run behind an owner
 * approval. It lives here rather than in sandbox/ so the sandbox keeps its one
 * unambiguous meaning: nothing it runs can touch the live workspace.
 */
export async function runSkillLive(options: {
  workspaceRoot: string;
  entry: string;
  args?: string[];
  timeoutMs?: number;
}): Promise<SandboxResult> {
  const entryAbs = resolvePath(options.workspaceRoot, options.entry);
  const liveDb = resolvePath(options.workspaceRoot, DB_FILENAME);
  const timeoutMs = options.timeoutMs ?? 30_000;

  return new Promise<SandboxResult>((resolve) => {
    const child = spawn(process.execPath, [entryAbs, ...(options.args ?? [])], {
      cwd: options.workspaceRoot,
      env: { ...process.env, KOS_DB: liveDb },
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
}
