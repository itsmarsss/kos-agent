import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";

import { isLoopbackHost } from "./bind.js";

type Upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

/** The port, held before anything boots, and the dashboard it hands requests to once there is one. */
export interface PortClaim {
  server: Server;
  /** From now on, requests go to `app` and upgrades to `upgrade`. */
  attach(app: Server, upgrade: Upgrade): void;
}

/**
 * A server to take the port with before the kernel boots, so a second start
 * fails before it marks the running host's turns cut short or starts its
 * daemons. Until the dashboard is attached it answers 503. Without the
 * dashboard token it answers nobody but this machine: the page it serves
 * carries the write key.
 */
export function portClaim(options: { token?: string }): PortClaim {
  let app: Server | undefined;
  let upgrade: Upgrade | undefined;
  const local = (req: IncomingMessage): boolean => options.token !== undefined || isLoopbackHost(req.socket.remoteAddress ?? "");
  const server = createServer((req, res) => {
    if (!local(req)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "KOS answers only this machine without KOS_DASHBOARD_TOKEN" }));
      return;
    }
    if (!app) {
      res.writeHead(503, { "content-type": "application/json", "retry-after": "1" });
      res.end(JSON.stringify({ ok: false, error: "KOS is starting" }));
      return;
    }
    app.emit("request", req, res);
  });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!local(req) || !upgrade) socket.destroy();
    else upgrade(req, socket, head);
  });
  return {
    server,
    attach(given, onUpgrade) {
      app = given;
      upgrade = onUpgrade;
    },
  };
}

/** Thrown by what needs the kernel before Kernel.boot has returned. */
export class StillStartingError extends Error {
  override name = "StillStartingError";
  constructor() {
    super("KOS is still starting; try again in a moment");
  }
}

/**
 * A value that exists only once boot returns, for callbacks handed out
 * before it does. A module activated inside Kernel.boot can call them then:
 * what must happen waits (`when`), what answers says KOS is still starting.
 */
export class BootBox<T> {
  private value: T | undefined;
  private readonly waiting: ((value: T) => void)[] = [];

  get current(): T | undefined {
    return this.value;
  }

  get(): T {
    if (this.value === undefined) throw new StillStartingError();
    return this.value;
  }

  /** Now, or once the value is set, in the order asked. */
  when(fn: (value: T) => void): void {
    if (this.value === undefined) this.waiting.push(fn);
    else fn(this.value);
  }

  set(value: T): void {
    this.value = value;
    for (const fn of this.waiting.splice(0)) fn(value);
  }
}

/**
 * The same object, each function in it (and in objects within it) first
 * asking `ready`, which throws while KOS is still starting: a device's
 * request during boot is refused in words rather than reading a kernel
 * that is not there yet.
 */
export function whenUp<T extends object>(deps: T, ready: () => unknown): T {
  const wrap = (value: unknown): unknown => {
    if (typeof value === "function") {
      return (...args: unknown[]) => {
        ready();
        return (value as (...a: unknown[]) => unknown)(...args);
      };
    }
    if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, wrap(v)]));
    }
    return value;
  };
  return wrap(deps) as T;
}

/** What a surface's start is recorded in: the health the dashboard shows. */
export interface SurfaceHealth {
  observe(key: string, label: string, ok: boolean, error: string | null): unknown;
}

/** How a surface's start went: started, or the error it failed with. */
export type SurfaceStart = { started: true } | { started: false; error: unknown };

/**
 * Start one surface on its own: one that fails (a reset bot token, a
 * webhook refused) is logged and marked unhealthy with why, and the host
 * goes on to the next surface, the schedule and the rest.
 */
export async function startSurface(
  name: string,
  start: () => Promise<void>,
  deps: { health: SurfaceHealth; log: (line: string) => void },
): Promise<SurfaceStart> {
  const key = `surface:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  try {
    await start();
    deps.health.observe(key, name, true, null);
    return { started: true };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    deps.log(`${name}: not started (${why}); everything else runs.`);
    deps.health.observe(key, name, false, `did not start: ${why}`);
    return { started: false, error };
  }
}

/** A login refused for who it is (a reset token, an intent switched off): trying again cannot help. */
const AUTH = /token|intent|unauthori[sz]ed|forbidden|\b(401|403|4004|4014)\b/i;
/** A login that did not reach Discord, or Discord not answering: worth trying again. */
const NETWORK = /enotfound|eai_again|econn(reset|refused|aborted)|etimedout|enetunreach|ehostunreach|socket hang up|fetch failed|timed? ?out|network|\b(429|5\d\d)\b/i;

/** Whether a failed login is the network's (try again) rather than the credentials' (do not). */
export function retryableLogin(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${(error as { code?: unknown }).code ?? ""}` : String(error);
  return NETWORK.test(text) && !AUTH.test(text);
}

/** The wait before the next try: 30 s, doubling, at most 15 min. */
export function backoffMs(attempt: number): number {
  return Math.min(30_000 * 2 ** attempt, 15 * 60_000);
}

/** How long a host has to shut down before it exits anyway. */
export const SHUTDOWN_MS = 8_000;

/**
 * Run each step of a shutdown in order within one deadline, and hand back
 * what did not finish (with why): a step that hangs or throws does not
 * keep the ones after it from running, and past the deadline the rest are
 * skipped and named.
 */
export async function stopWithin(steps: [string, () => Promise<unknown> | unknown][], deadlineMs = SHUTDOWN_MS): Promise<string[]> {
  const end = Date.now() + deadlineMs;
  const left: string[] = [];
  // A step that ran out the clock used the deadline up, though a timer may fire a millisecond before it.
  let spent = false;
  for (const [name, step] of steps) {
    const remaining = end - Date.now();
    if (spent || remaining <= 0) {
      left.push(`${name} (no time left)`);
      continue;
    }
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), remaining)));
    try {
      const outcome = await Promise.race([Promise.resolve().then(step), timedOut]);
      if (outcome === "timeout") {
        spent = true;
        left.push(`${name} (still going at the deadline)`);
      }
    } catch (err) {
      left.push(`${name} (${err instanceof Error ? err.message : String(err)})`);
    } finally {
      clearTimeout(timer);
    }
  }
  return left;
}

/** What the host was started with that a restart must keep. */
export interface StartFlags {
  rootDir: string;
  host: string;
  port: number;
  discord?: boolean;
  requireDiscord?: boolean;
  sitesPort?: number;
}

/** `kos restart`'s arguments for this host: the same workspace, address and surfaces, not the defaults. */
export function restartArgs(main: string, flags: StartFlags): string[] {
  return [
    main,
    "restart",
    "--workspace",
    flags.rootDir,
    "--host",
    flags.host,
    "--port",
    String(flags.port),
    ...(flags.discord === false ? ["--no-discord"] : []),
    ...(flags.requireDiscord ? ["--discord"] : []),
    ...(flags.sitesPort !== undefined ? ["--sites-port", String(flags.sitesPort)] : []),
  ];
}

/**
 * How long `kos start` and `kos restart` wait for a host to answer: a cold
 * boot that opens Chrome, logs Discord in and syncs the server ran past
 * the 15 s it once was, and the command said it failed while KOS came up.
 */
export const HOST_WAIT_MS = 60_000;

/** Who answered a host's /api/health: its pid and its workspace (real path). */
export interface HostSeen {
  pid: number;
  workspace: string;
}

export type RestartResult = { ok: true; pid: number } | { ok: false; why: string };

/**
 * Whether a restart landed: this workspace's host answering on its port
 * under a pid other than `before`, the host from before the restart (none
 * when nothing ran). The old host still answering, another workspace's, or
 * nothing at all is waited past until `timeoutMs`, and the last of them is
 * why it did not.
 */
export async function awaitNewHost(options: {
  probe: () => Promise<HostSeen | undefined>;
  workspace: string;
  before: number | undefined;
  timeoutMs: number;
  everyMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<RestartResult> {
  const { probe, workspace, before, timeoutMs, everyMs = 500, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = options;
  const end = now() + timeoutMs;
  let why = "nothing answered";
  for (;;) {
    const seen = await probe();
    if (seen && seen.workspace === workspace && seen.pid !== before) return { ok: true, pid: seen.pid };
    if (seen) why = seen.workspace !== workspace ? `another workspace's host answered (pid ${seen.pid}, ${seen.workspace})` : `only the host from before answered (pid ${seen.pid})`;
    if (now() >= end) return { ok: false, why };
    await sleep(everyMs);
  }
}

/**
 * What a restart under launchd does once the old host is stopped: start
 * it, unless launchd already runs one of its own under a new pid (a host
 * that exited badly is brought back by KeepAlive), which `kickstart -k`
 * would kill mid-boot. A host still running as the old pid is the one
 * stop could not end, and kickstart -k ends it.
 */
export function launchdStep(running: number | undefined, before: number | undefined): "kickstart" | "wait" {
  return running !== undefined && running !== before ? "wait" : "kickstart";
}
