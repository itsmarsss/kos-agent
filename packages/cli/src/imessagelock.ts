import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * One process per iMessage thread, across every workspace on the machine.
 *
 * Two hosts watching the same thread do not merely duplicate work: each reads
 * the other's replies as the owner speaking, answers them, and is answered
 * back. It runs until someone notices, and every lap sends the owner two real
 * messages and spends two turns. It happened here -- a test host on a scratch
 * workspace was left watching while the real host was switched on, and the
 * two of them held a thirty-message argument about how many projects exist,
 * each correct about its own workspace.
 *
 * Nothing inside a workspace can prevent that, because the two hosts had
 * different workspaces. The claim therefore lives on the machine, beside the
 * handle it is about, and is released when the process exits.
 */

function lockPath(handle: string): string {
  // The handle is a phone number or an address; neither is safe as a filename.
  const safe = handle.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return join(homedir(), ".kos", "locks", `imessage-${safe}.lock`);
}

/** Is a process with this id still running? */
function alive(pid: number): boolean {
  try {
    // Signal 0 checks for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface HandleClaim {
  /** Give the thread up, so the next host may take it. */
  release(): void;
}

/**
 * Claim the right to watch one thread, or report who already has it.
 *
 * A lock left behind by a process that has since died is taken over rather
 * than treated as a conflict: a host that was killed should not lock the
 * owner out of their own surface until they find the file.
 */
export function claimHandle(
  handle: string,
): { ok: true; claim: HandleClaim } | { ok: false; heldBy: number } {
  const path = lockPath(handle);
  mkdirSync(dirname(path), { recursive: true });

  if (existsSync(path)) {
    const held = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    if (Number.isInteger(held) && held !== process.pid && alive(held)) {
      return { ok: false, heldBy: held };
    }
  }

  writeFileSync(path, String(process.pid), "utf8");
  return {
    ok: true,
    claim: {
      release: () => {
        try {
          // Only if it is still ours: a later host may have taken it over
          // after we were killed and the file rewritten.
          if (existsSync(path)) {
            const held = readFileSync(path, "utf8").trim();
            if (held === String(process.pid)) rmSync(path, { force: true });
          }
        } catch {
          // A stale lock is recovered by the liveness check above, so failing
          // to tidy up is not worth reporting at shutdown.
        }
      },
    },
  };
}
