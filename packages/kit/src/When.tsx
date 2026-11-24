import type { ReactElement } from "react";

import { clockWords, momentWords, timeCard, timeWords } from "@kos/shared";

import { TimeCard } from "./ChatTime.js";
import { Tooltip } from "./Tooltip.js";

/** The words a moment is said in: how long ago or off, the moment, or the clock time alone. */
const SAY = { ago: timeWords, moment: momentWords, clock: (at: number) => clockWords(at) } as const;

/**
 * A moment as a list says it: how long ago or how far off, in the one short
 * vocabulary (`timeWords`: "5m ago", "in 3h"); with `say`, the moment
 * ("Tomorrow 8:00 AM", `momentWords`) or, in a list grouped by day, the
 * clock time alone ("4:09 PM", `clockWords`). Hovered or focused, it opens
 * the one time card a chat's times open: the date in full over the clock
 * time, which is also its row's description for a screen reader. The words
 * in the row never change, so nothing moves. Plain words,
 * never a link: what a row opens, its title opens.
 */
export function When({ at, now, say = "ago" }: { at: number; now?: number; say?: keyof typeof SAY }): ReactElement {
  return (
    <Tooltip tip={<TimeCard seconds={at / 1000} />} describe={timeCard(at / 1000).join(" ")}>
      <time className="when" dateTime={new Date(at).toISOString()}>
        {SAY[say](at, now)}
      </time>
    </Tooltip>
  );
}
