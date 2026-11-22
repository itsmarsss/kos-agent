import type { ReactElement } from "react";

import { momentWords, timeWords } from "@kos/shared";

/**
 * A moment as a list says it: how long ago or how far off, in the one short
 * vocabulary (`timeWords`: "5m ago", "in 3h"), with the clock time in full
 * on hover. Plain words, never a link: what a row opens, its title opens.
 */
export function When({ at, now }: { at: number; now?: number }): ReactElement {
  return (
    <time className="when" dateTime={new Date(at).toISOString()} title={momentWords(at, now)}>
      {timeWords(at, now)}
    </time>
  );
}
