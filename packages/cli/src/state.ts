import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { dialHost, isLocalHost } from "./bind.js";

/**
 * On-disk pointer to the multi-modal host (kos start), one per workspace.
 *
 * Kept under ~/.kos/run, never in the workspace: a program the owner
 * approved can write the workspace, and what this file names is where the
 * CLI sends the dashboard token and the write key, and which pid it signals.
 */
export interface DaemonState {
  pid: number;
  host: string;
  port: number;
  workspace: string;
  startedAt: string;
  discord: boolean;
}

/** Where a workspace's host state is: by a hash of its path, so two workspaces each have one. */
export function statePath(workspace: string, home = homedir()): string {
  const key = createHash("sha256").update(resolve(workspace)).digest("hex").slice(0, 16);
  return join(home, ".kos", "run", `${key}.json`);
}

export function readDaemonState(workspace: string, home = homedir()): DaemonState | null {
  const path = statePath(workspace, home);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DaemonState;
  } catch {
    return null;
  }
}

/** Written 0600 in a 0700 folder: the owner's alone. */
export function writeDaemonState(workspace: string, state: DaemonState, home = homedir()): void {
  const path = statePath(workspace, home);
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function clearDaemonState(workspace: string, home = homedir()): void {
  const path = statePath(workspace, home);
  if (existsSync(path)) unlinkSync(path);
}

/** True if pid looks alive (signal 0). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The URL a host in the state is reached at: on this machine, an any-address by loopback. */
export function baseUrlOf(state: Pick<DaemonState, "host" | "port">): string {
  const host = dialHost(state.host);
  return `http://${host.includes(":") ? `[${host}]` : host}:${state.port}`;
}

/** Whether the state's host is this workspace's KOS, and where it answers; or why it is not trusted. */
export type HostCheck = { ok: true; baseUrl: string } | { ok: false; why: string };

/**
 * Check the host the state names before anything is sent to it or its pid
 * is signalled: it must be on this machine, and its /api/health must answer
 * with the state's pid and workspace. The token goes only to this machine;
 * the write key, which the caller adds after, only to a host that passed.
 */
export async function verifyHost(state: DaemonState, token: string | undefined, timeoutMs = 2_000): Promise<HostCheck> {
  if (!isLocalHost(state.host)) return { ok: false, why: `it names ${state.host}, which is not this machine` };
  const baseUrl = baseUrlOf(state);
  try {
    const res = await fetch(`${baseUrl}/api/health`, {
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const health = (await res.json()) as { ok?: unknown; pid?: unknown; workspace?: unknown };
    if (!res.ok || health.ok !== true) return { ok: false, why: `${baseUrl} did not answer as KOS (${res.status})` };
    if (health.pid !== state.pid || health.workspace !== state.workspace) {
      return { ok: false, why: `${baseUrl} is another KOS (pid ${String(health.pid)}, workspace ${String(health.workspace)})` };
    }
    return { ok: true, baseUrl };
  } catch (err) {
    return { ok: false, why: `${baseUrl} did not answer (${err instanceof Error ? err.message : String(err)})` };
  }
}

/** A process's command line, or undefined when there is no such process. */
function commandOf(pid: number): string | undefined {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000 }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Whether a pid is a KOS host for this workspace by its command line: this
 * CLI's own main.js, given this workspace. For a host that does not answer
 * (wedged), so `kos stop` can still stop it and never a stranger with a
 * reused pid.
 */
export function isKosHostProcess(pid: number, main: string, workspace: string, command = commandOf): boolean {
  const line = command(pid);
  return line !== undefined && line.includes(main) && ` ${line} `.includes(` --workspace ${workspace} `);
}
