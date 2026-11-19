import { useSyncExternalStore } from "react";

/**
 * Whether KOS is answering this tab, as every request finds it.
 *
 * The sidebar read only the last status that came back, so with the host
 * gone it went on saying "Running" in green, and a send printed the
 * browser's "Failed to fetch" where KOS's reply goes. Here each request
 * reports in: any answer at all means KOS is there; a request that never
 * reached it is a miss. One miss is a blip; misses on two ticks apart, or a
 * change the owner made that never arrived, mean KOS is down, until the next
 * answer, which the dashboard's own poll keeps asking for.
 *
 * Apart from that, a page served by an earlier boot of KOS holds an old write
 * key. The request layer fetches the new one and tries again; when it cannot,
 * the page is stale, and only a reload mends it.
 */
export interface Reach {
  /** KOS has not answered for a while. */
  down: boolean;
  /** This page's write key is from an earlier boot and could not be renewed. */
  stale: boolean;
}

/** Misses this far apart are not one blip. */
const BLIP_MS = 1_500;

let state: Reach = { down: false, stale: false };
let firstMiss: number | undefined;
const listeners = new Set<() => void>();

function set(next: Reach): void {
  if (next.down === state.down && next.stale === state.stale) return;
  state = next;
  for (const listener of listeners) listener();
}

/** KOS answered (any status): it is there. */
export function reached(): void {
  firstMiss = undefined;
  set({ ...state, down: false });
}

/** A request never reached KOS; `change` for one the owner made, which says so at once. */
export function missed(change = false, now = Date.now()): void {
  firstMiss ??= now;
  if (change || now - firstMiss >= BLIP_MS) set({ ...state, down: true });
}

/** The write key could not be renewed: the page must be reloaded. */
export function wentStale(): void {
  set({ ...state, stale: true });
}

/** The state now, and a way to hear it change. */
export function reach(): Reach {
  return state;
}

export function onReach(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The reach, redrawn as it changes. */
export function useReach(): Reach {
  return useSyncExternalStore(onReach, reach, reach);
}

/** Back to the start, for tests. */
export function resetReach(): void {
  firstMiss = undefined;
  state = { down: false, stale: false };
}

/** A request that never reached KOS, said for a person rather than as the browser's "Failed to fetch". */
export class Unreached extends Error {
  override name = "Unreached";
  constructor() {
    super("KOS is not answering. It may be restarting; this tab keeps trying.");
  }
}

/** The page is from an earlier boot of KOS and a change cannot be proven from it. */
export class StalePage extends Error {
  override name = "StalePage";
  constructor() {
    super("KOS restarted. Reload the page to keep working; what you typed is kept.");
  }
}
