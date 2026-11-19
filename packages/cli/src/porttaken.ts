import type { ChildProcess } from "node:child_process";
import { createServer } from "node:net";

/** A start refused because something else holds the port. */
export class PortTakenError extends Error {
  override name = "PortTakenError";
}

interface KosAnswer {
  pid: number;
  workspace: string;
}

/** The KOS answering health at host:port, if one does for this token. Bounded: a holder that never answers is not KOS. */
async function kosAt(host: string, port: number, token: string | undefined): Promise<KosAnswer | null> {
  try {
    const res = await fetch(`http://${host}:${port}/api/health`, {
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      signal: AbortSignal.timeout(1_000),
    });
    const health = (await res.json()) as Partial<KosAnswer> & { ok?: unknown };
    return res.ok && health.ok === true && typeof health.pid === "number"
      ? { pid: health.pid, workspace: String(health.workspace) }
      : null;
  } catch {
    return null;
  }
}

function takenBy(port: number, holder: KosAnswer | null): string {
  const by = holder
    ? `another KOS (pid ${holder.pid}, workspace ${holder.workspace})`
    : "a process that is not KOS, or a KOS this token cannot reach";
  return `port ${port} is already in use by ${by}; stop it or pick --port`;
}

/** What to tell the owner about whoever holds the port. */
export async function portTakenMessage(host: string, port: number, token?: string): Promise<string> {
  return takenBy(port, await kosAt(host, port, token));
}

/** Whether this process could listen on host:port right now. */
export function portFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") resolve(false);
      else reject(err);
    });
    probe.listen({ host, port, exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

export interface AwaitOwnHostOptions {
  child: ChildProcess;
  host: string;
  port: number;
  token?: string;
  logPath: string;
  timeoutMs?: number;
  intervalMs?: number;
}

const exited = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null;

/** SIGTERM, then SIGKILL if it is still there after a grace period. */
async function stopChild(child: ChildProcess, graceMs = 3_000): Promise<void> {
  if (exited(child)) return;
  const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
  await gone;
  clearTimeout(timer);
}

/**
 * Wait for the host this start spawned to be the one answering on the
 * port. Another KOS answering, or the child exiting while something holds
 * the port, is a refused start, and the child is stopped. Returns null on
 * success, else what to tell the owner.
 */
export async function awaitOwnHost(options: AwaitOwnHostOptions): Promise<string | null> {
  const { child, host, port, token, logPath } = options;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const answer = await kosAt(host, port, token);
    if (answer && answer.pid === child.pid) return null;
    if (answer) {
      await stopChild(child);
      return takenBy(port, answer);
    }
    if (exited(child)) {
      if (!(await portFree(host, port))) return portTakenMessage(host, port, token);
      return `host exited (${child.exitCode ?? child.signalCode}) before answering; check ${logPath}`;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  // Still booting is not a refusal: a slow first start (Chrome, models) is left running.
  const holder = await kosAt(host, port, token);
  if (holder && holder.pid !== child.pid) {
    await stopChild(child);
    return takenBy(port, holder);
  }
  return `host did not answer within ${Math.round(timeoutMs / 1000)}s and is left running (pid ${child.pid}); check ${logPath}`;
}
