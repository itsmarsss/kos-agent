/**
 * Long-running programs the agent has written.
 *
 * A site is files, served by KOS. A daemon is a process: an API a tracker
 * talks to, a worker that watches a folder, a bot of its own. KOS is supposed
 * to be able to build a Python or TypeScript app, and an app that only runs
 * while someone is watching is not one.
 *
 * What confines it is the same perimeter as everything else: the entry path
 * goes through the jail, the working directory is the project it belongs to,
 * and the environment is an allow-list rather than the host's, so a daemon
 * cannot read the owner's credentials out of it. That bounds what it can see.
 * What it can *do* is bounded by the container, which is where KOS is meant to
 * run once anything executes unattended.
 */

/** What runs it. Anything else is a program KOS has no interpreter for. */
export type DaemonRuntime = "node" | "python";

export interface Daemon {
  id: number;
  /** The project it belongs to; a daemon is part of one thing, like a site. */
  project: string;
  name: string;
  runtime: DaemonRuntime;
  /** Workspace-relative path to the program, resolved through the jail. */
  entry: string;
  args: string[];
  /**
   * The port KOS assigned it, or null for a daemon that serves nothing. It is
   * handed over as PORT, and the dashboard proxies to it, so two daemons
   * cannot land on the same one by both picking 3000.
   */
  port: number | null;
  /** Whether it should be running. Distinct from whether it is. */
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export type DaemonState =
  | "running"
  | "stopped"
  /** Exited too often, too fast. Restarting again would just spin. */
  | "crashed"
  | "starting";

export interface DaemonStatus {
  id: number;
  state: DaemonState;
  pid: number | null;
  /** When the current run started, for "how long has this been up". */
  since: number | null;
  restarts: number;
  /** Why it is not running, when that is the interesting part. */
  lastError: string | null;
  exitCode: number | null;
}
