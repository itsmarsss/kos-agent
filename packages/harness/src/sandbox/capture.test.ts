import { describe, expect, it, vi } from "vitest";

import { runCaptured } from "./capture.js";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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
    // Reaped by whoever inherited it, a moment after it dies.
    await vi.waitFor(() => expect(alive(sleeper)).toBe(false), { timeout: 2_000 });
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
