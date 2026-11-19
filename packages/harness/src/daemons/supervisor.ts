import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolvePath } from "../jail/resolvePath.js";
import { RESERVED } from "../kernel/files.js";
import { childEnv, findProgram } from "../sandbox/env.js";
import { jailedProgram } from "../sandbox/jail.js";
import { folderHash } from "../store/folderhash.js";
import type { Daemon, DaemonStatus } from "./types.js";

/**
 * Keeping the agent's programs up.
 *
 * A daemon is spawned, watched, and restarted when it dies. The restarting is
 * the part worth being careful about: a program that crashes on startup will
 * crash again immediately, and a naive supervisor turns that into a spin that
 * eats the machine and fills the log with the same line forever. So restarts
 * back off, and a daemon that keeps dying is marked crashed and left alone
 * until somebody looks at it.
 *
 * Confinement, in order of how much it is worth:
 *
 * - The entry path goes through resolvePath, so a daemon cannot be pointed at
 *   something outside the workspace, including through a symlink.
 * - The working directory is inside the workspace, so relative paths stay
 *   there.
 * - The environment is the same allow-list a sandboxed skill gets: no API
 *   keys, no Discord token, nothing the owner's shell happens to carry.
 * - HOST is 127.0.0.1 and PORT is assigned, so a well-behaved server is
 *   reachable through the dashboard proxy and not from the network.
 *
 * - It runs in the jail: it writes only data/ beside its entry, reads none
 *   of KOS's own state, database or settings, and reaches this machine only
 *   unless the owner approved more. KOS's own ports are refused either way.
 *   Where there is no jail it does not run.
 * - The hash of its entry's folder is kept when the owner approves it: the
 *   entry and every helper beside it, all but data/ and the daemons/ logs.
 *   A daemon whose code changed since is not started, on a restart or a
 *   reboot, until the owner approves it again: the yes was to that code.
 */

/** Where a daemon writes: data/ in its entry's folder, left out of its hash. */
export const DAEMON_DATA_DIR = "data";

/** The hash of a daemon's code as it is now: its entry's folder, read through the jail. */
export function daemonCodeHash(workspaceRoot: string, entry: string): string {
  return folderHash(dirname(resolvePath(workspaceRoot, entry)), [DAEMON_DATA_DIR, "daemons"]);
}

/** Said when a daemon's entry is not the code the owner approved. */
export const CODE_CHANGED = "its code changed since the owner approved it: start it again with daemons.start, which asks the owner";

/** Restart delays, in order. A daemon that gets past the last one starts over. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000];
/** Deaths in a row before it is left alone. */
const CRASH_LIMIT = 5;
/** Staying up this long means the last crash is not part of a loop. */
const HEALTHY_MS = 60_000;
/** Grace between asking a daemon to stop and insisting. */
const KILL_AFTER_MS = 5_000;
/** Log lines held in memory for the dashboard. */
const TAIL_LINES = 400;

interface Running {
  child: ChildProcess;
  since: number;
  /** Set while a stop is deliberate, so the exit is not treated as a crash. */
  stopping: boolean;
  timer?: NodeJS.Timeout;
}

export interface SupervisorOptions {
  workspaceRoot: string;
  /** Where a daemon's output is appended, workspace-relative. */
  logPathFor?: (daemon: Daemon) => string;
  /** Told when a daemon dies for good, so the owner can hear about it. */
  onCrash?: (daemon: Daemon, reason: string) => void;
  /**
   * The daemon's row as it is now, read before every start: a restart that
   * comes due after a stop or a removal finds it off or gone and does nothing.
   */
  current?: (id: number) => Daemon | undefined;
  /** True when the host itself runs in the container, which is the jail. */
  contained?: boolean;
}

function defaultLogPath(daemon: Daemon): string {
  return `projects/${daemon.project}/daemons/${daemon.name}.log`;
}

export class DaemonSupervisor {
  private readonly running = new Map<number, Running>();
  private readonly status = new Map<number, DaemonStatus>();
  private readonly tails = new Map<number, string[]>();
  /** Restarts waiting out their backoff, so a stop or a removal can call them off. */
  private readonly pending = new Map<number, NodeJS.Timeout>();
  private closed = false;

  constructor(private readonly options: SupervisorOptions) {}

  /** What this daemon is doing, for the tool and the dashboard. */
  statusOf(id: number): DaemonStatus {
    return (
      this.status.get(id) ?? {
        id,
        state: "stopped",
        pid: null,
        since: null,
        restarts: 0,
        lastError: null,
        exitCode: null,
      }
    );
  }

  /** The last few hundred lines it printed. */
  logs(id: number, lines = 100): string[] {
    const tail = this.tails.get(id) ?? [];
    return tail.slice(-Math.max(1, lines));
  }

  isRunning(id: number): boolean {
    return this.running.has(id);
  }

  /**
   * Start it, or say why it cannot start.
   *
   * Throws rather than recording a crash: a daemon whose entry does not exist
   * has a problem the caller can fix now, and reporting it as a crash puts it
   * in a backoff loop over a typo.
   */
  start(asked: Daemon): void {
    if (this.closed) throw new Error("the host is shutting down");
    if (this.running.has(asked.id)) return;
    this.cancelRestart(asked.id);
    // As the store has it now: turned off or removed since, it stays down.
    const daemon = this.options.current ? this.options.current(asked.id) : asked;
    if (!daemon?.enabled) return;

    // The jail, before anything is spawned. A path that resolves outside the
    // workspace is not a daemon, whatever the row says.
    const root = this.options.workspaceRoot;
    const entry = resolvePath(root, daemon.entry);
    const cwd = resolvePath(root, daemon.project ? `projects/${daemon.project}` : ".");
    if (daemon.codeHash === null || daemonCodeHash(root, daemon.entry) !== daemon.codeHash) {
      this.status.set(daemon.id, { ...this.statusOf(daemon.id), state: "stopped", pid: null, since: null, lastError: CODE_CHANGED });
      throw new Error(`${daemon.project}/${daemon.name} was not started: ${CODE_CHANGED}`);
    }

    const data = join(dirname(entry), DAEMON_DATA_DIR);
    mkdirSync(data, { recursive: true });
    const env = childEnv(
      { home: data, tmp: data },
      {
        KOS_DAEMON: "1",
        // Loopback: a daemon is reached through the dashboard proxy, not by
        // being on the network itself.
        HOST: "127.0.0.1",
        ...(daemon.port !== null ? { PORT: String(daemon.port) } : {}),
      },
    );

    // The interpreter, and the folder it loads its own libraries from, which may be under the owner's home.
    const interpreter = daemon.runtime === "python" ? findProgram("python3", env.PATH ?? "") : process.execPath;
    if (!interpreter) throw new Error(`could not start ${daemon.name}: python3 is not installed on this machine`);
    const program = jailedProgram(interpreter, [entry, ...daemon.args], {
      workspaceRoot: root,
      writes: [data],
      hidden: [...RESERVED, ".env"].map((name) => join(root, name)),
      reads: [dirname(dirname(realpathSync(interpreter)))],
      // Open, it resolves names as well, which a sealed program asks a service for.
      ...(daemon.network === "open" ? { services: ["com.apple.dnssd.service"] } : { network: "local" as const }),
      sealed: true,
      ...(this.options.contained !== undefined ? { contained: this.options.contained } : {}),
    });

    let child: ChildProcess;
    try {
      child = spawn(program.file, program.args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      throw new Error(
        `could not start ${daemon.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const previous = this.status.get(daemon.id);
    this.status.set(daemon.id, {
      id: daemon.id,
      state: "running",
      pid: child.pid ?? null,
      since: Date.now(),
      restarts: previous?.restarts ?? 0,
      lastError: null,
      exitCode: null,
    });
    this.running.set(daemon.id, { child, since: Date.now(), stopping: false });

    const record = (chunk: Buffer, stream: "out" | "err"): void => {
      const text = chunk.toString("utf8");
      const tail = this.tails.get(daemon.id) ?? [];
      for (const line of text.split("\n")) {
        if (line === "") continue;
        tail.push(stream === "err" ? `[err] ${line}` : line);
      }
      this.tails.set(daemon.id, tail.slice(-TAIL_LINES));
      this.append(daemon, text);
    };
    child.stdout?.on("data", (chunk: Buffer) => record(chunk, "out"));
    child.stderr?.on("data", (chunk: Buffer) => record(chunk, "err"));

    child.on("error", (err: Error) => {
      const status = this.statusOf(daemon.id);
      this.status.set(daemon.id, { ...status, lastError: err.message });
    });

    child.on("exit", (code, signal) => {
      // Read before dropping the record: whether the stop was asked for is the
      // difference between "restart it" and "leave it alone".
      const deliberate = this.running.get(daemon.id)?.stopping ?? false;
      this.running.delete(daemon.id);
      this.onExit(daemon, code, signal, deliberate);
    });
  }

  /** Ask it to stop, and insist if it does not. */
  async stop(id: number): Promise<void> {
    const run = this.running.get(id);
    if (!run) {
      // Between runs, waiting out a backoff: the restart is called off, or the stop would be undone when it fires.
      this.cancelRestart(id);
      const status = this.statusOf(id);
      this.status.set(id, { ...status, state: "stopped", pid: null, since: null });
      return;
    }
    run.stopping = true;
    if (run.timer) clearTimeout(run.timer);
    this.cancelRestart(id);

    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(hard);
        resolve();
      };
      const hard = setTimeout(() => {
        // SIGTERM is a request. A daemon that ignores it still has to go, or
        // "stop" is something the owner cannot rely on.
        run.child.kill("SIGKILL");
        resolve();
      }, KILL_AFTER_MS);
      run.child.once("exit", done);
      run.child.kill("SIGTERM");
    });

    this.running.delete(id);
    const status = this.statusOf(id);
    this.status.set(id, {
      ...status,
      state: "stopped",
      pid: null,
      since: null,
      restarts: 0,
    });
  }

  /** Stop everything, for a host that is going down. */
  async stopAll(): Promise<void> {
    this.closed = true;
    for (const id of [...this.pending.keys()]) this.cancelRestart(id);
    for (const [, run] of this.running) {
      if (run.timer) clearTimeout(run.timer);
      run.stopping = true;
    }
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
  }

  private onExit(
    daemon: Daemon,
    code: number | null,
    signal: NodeJS.Signals | null,
    deliberate: boolean,
  ): void {
    const status = this.statusOf(daemon.id);
    const ranFor = status.since ? Date.now() - status.since : 0;

    // As the store has it now: one turned off or removed while it ran is not brought back.
    const wanted = this.options.current ? this.options.current(daemon.id)?.enabled === true : daemon.enabled;
    if (deliberate || this.closed || !wanted) {
      this.status.set(daemon.id, {
        ...status,
        state: "stopped",
        pid: null,
        since: null,
        exitCode: code,
      });
      return;
    }

    // A daemon that stayed up is not in a crash loop, whatever happened before.
    const restarts = ranFor >= HEALTHY_MS ? 1 : status.restarts + 1;
    const reason =
      signal !== null ? `killed by ${signal}` : `exited with code ${code ?? "unknown"}`;

    if (restarts > CRASH_LIMIT) {
      this.status.set(daemon.id, {
        ...status,
        state: "crashed",
        pid: null,
        since: null,
        restarts,
        exitCode: code,
        lastError: `${reason}, ${CRASH_LIMIT} times in a row`,
      });
      this.options.onCrash?.(
        daemon,
        `${daemon.project}/${daemon.name} ${reason} ${CRASH_LIMIT} times in a row and has been left stopped`,
      );
      return;
    }

    const wait = BACKOFF_MS[Math.min(restarts - 1, BACKOFF_MS.length - 1)]!;
    this.status.set(daemon.id, {
      ...status,
      state: "starting",
      pid: null,
      since: null,
      restarts,
      exitCode: code,
      lastError: reason,
    });
    const timer = setTimeout(() => {
      this.pending.delete(daemon.id);
      if (this.closed) return;
      try {
        this.start(daemon);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const now = this.statusOf(daemon.id);
        this.status.set(daemon.id, { ...now, state: "crashed", lastError: reason });
        // Left down unattended, it is news, as a crash loop is.
        this.options.onCrash?.(daemon, reason);
      }
    }, wait);
    this.pending.set(daemon.id, timer);
    // Not keeping the process alive on its own account: a pending restart is
    // no reason for the host to refuse to exit.
    timer.unref?.();
  }

  private cancelRestart(id: number): void {
    const timer = this.pending.get(id);
    if (timer) clearTimeout(timer);
    this.pending.delete(id);
  }

  private append(daemon: Daemon, text: string): void {
    try {
      const path = resolvePath(
        this.options.workspaceRoot,
        this.options.logPathFor?.(daemon) ?? defaultLogPath(daemon),
      );
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, text);
    } catch {
      // A daemon whose log cannot be written is still a daemon worth running.
      // The tail in memory is what the dashboard reads anyway.
    }
  }
}
