import { useEffect, useRef } from "react";

import { announce } from "@kos/kit";

import type { PendingAction } from "./api.js";

/** What a screen reader is told of asks that arrived since the last look: one each, or a count past a few. */
export function arrivalWords(arrived: readonly PendingAction[]): string | null {
  if (arrived.length === 0) return null;
  if (arrived.length > 3) return `${arrived.length} new approvals in the Inbox`;
  return arrived.map((a) => `New approval. ${a.asker ?? "KOS"} asks: ${a.title ?? a.summary ?? a.tool}`).join(". ");
}

/**
 * Says an ask arriving, wherever the owner is: the Inbox's count and cards
 * changed with no word, so a screen reader never heard that KOS was waiting.
 * The asks there on the first read are not news.
 */
export function useAnnounceArrivals(approvals: readonly PendingAction[], loaded: boolean): void {
  const seen = useRef<Set<number> | null>(null);
  useEffect(() => {
    if (!loaded) return;
    const ids = new Set(approvals.map((a) => a.id));
    if (seen.current) {
      const words = arrivalWords(approvals.filter((a) => !seen.current!.has(a.id)));
      if (words) announce(words);
    }
    seen.current = ids;
  }, [approvals, loaded]);
}
