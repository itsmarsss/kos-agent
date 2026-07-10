import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * On-disk pointer to the multi-modal host (kos start). Scoped by workspace so
 * multiple workspaces can each have one daemon.
 */

export interface DaemonState {
  pid: number;
  host: string;
  port: number;
  workspace: string;
  startedAt: string;
  discord: boolean;
}

export function statePath(workspace: string): string {
  return join(workspace, ".kos", "daemon.json");
}

/** Fallback when probing without a workspace open. */
export function globalStatePath(): string {
  return join(homedir(), ".kos", "daemon.json");
}

export function readDaemonState(workspace: string): DaemonState | null {
  const path = statePath(workspace);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DaemonState;
  } catch {
    return null;
  }
}

export function writeDaemonState(state: DaemonState): void {
  const path = statePath(state.workspace);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
  // Mirror for quick discovery when workspace is default.
  try {
    const g = globalStatePath();
    mkdirSync(dirname(g), { recursive: true });
    writeFileSync(g, JSON.stringify(state, null, 2));
  } catch {
    // non-fatal
  }
}

export function clearDaemonState(workspace: string): void {
  const path = statePath(workspace);
  if (existsSync(path)) unlinkSync(path);
  const g = globalStatePath();
  if (existsSync(g)) {
    try {
      const cur = JSON.parse(readFileSync(g, "utf8")) as DaemonState;
      if (cur.workspace === workspace) unlinkSync(g);
    } catch {
      // ignore
    }
  }
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
