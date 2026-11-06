import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { runCaptured } from "./capture.js";

/**
 * Not running: reaped, or dead and waiting to be. A zombie still answers
 * signal 0, and whether it is reaped is up to whoever inherited it (PID 1
 * in a container), which is not what this checks.
 */
const ended = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  try {
    return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z");
  } catch {
    // ps exits non-zero when the process is gone by the time it looks.
    return true;
  }
};

describe.runIf(process.platform !== "win32")("a program stopped under its turn", () => {
  it("ends at once with what it printed, and takes what it started with it", async () => {
    const stop = new AbortController();
    const started = Date.now();
    // A shell that starts a long sleep and waits on it: killing the shell alone left the sleep behind.
    const run = runCaptured(
      { file: "/bin/sh", args: ["-c", "sleep 30 & echo $!; wait"] },
      { cwd: process.cwd(), env: { PATH: process.env.PATH ?? "" }, timeoutMs: 60_000, maxOutput: 1000, signal: stop.signal },
    );
    setTimeout(() => stop.abort(), 300);
    const result = await run;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result).toMatchObject({ stopped: true, timedOut: false });
    const sleeper = Number(result.stdout.trim());
    expect(sleeper).toBeGreaterThan(0);
    await vi.waitFor(() => expect(ended(sleeper)).toBe(true), { timeout: 2_000 });
  });

  it("counts a zombie as ended, as a container without an init leaves one", async () => {
    // The shell becomes a sleep that never reaps the child it started, so that child stays a zombie.
    const parent = spawn("/bin/sh", ["-c", "sleep 0 & echo $!; exec sleep 5"], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      const zombie = await new Promise<number>((resolve) => parent.stdout.once("data", (d: Buffer) => resolve(Number(d.toString().trim()))));
      await vi.waitFor(() => expect(execFileSync("ps", ["-o", "stat=", "-p", String(zombie)], { encoding: "utf8" })).toMatch(/^Z/), { timeout: 2_000 });
      expect(ended(zombie)).toBe(true);
    } finally {
      parent.kill("SIGKILL");
    }
  });

  it("ends at once when the turn was already stopped", async () => {
    const stop = new AbortController();
    stop.abort();
    const result = await runCaptured(
      { file: "/bin/sh", args: ["-c", "sleep 30"] },
      { cwd: process.cwd(), env: { PATH: process.env.PATH ?? "" }, timeoutMs: 60_000, maxOutput: 1000, signal: stop.signal },
    );
    expect(result.stopped).toBe(true);
  });
});

describe("the container", () => {
  it("runs under an init that reaps what a killed program left behind", () => {
    const dockerfile = readFileSync(new URL("../../../../Dockerfile", import.meta.url), "utf8");
    expect(dockerfile).toMatch(/^ENTRYPOINT \["\/usr\/bin\/tini", "--"\]$/m);
  });
});
