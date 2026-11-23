import { useEffect, useState } from "react";

import { HttpError } from "./api.js";

/**
 * Whether the thing an address names is there.
 *
 * A bad link used to land somewhere else without a word: a chat that was
 * never there opened the landing, a missing file the workspace root, a
 * build that was never started the overview. Each page asks once, and an
 * answer of "not there" draws NotFound in the page's place.
 */
export type Found = "asking" | "here" | "gone";

/**
 * KOS said the thing is not there: a 4xx other than a refused key. A broken
 * line or a 5xx is not an answer about the thing, so it is never "gone".
 */
export function isGone(err: unknown): boolean {
  return err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 403;
}

/**
 * Asks `ask` whenever `key` changes: true is here, false or a not-there
 * refusal is gone. A null key names nothing, which is here.
 */
export function useFound(key: string | null, ask: () => Promise<boolean>): Found {
  const [answer, setAnswer] = useState<{ key: string; found: Found } | null>(null);
  useEffect(() => {
    if (key === null) return undefined;
    let live = true;
    ask().then(
      (here) => live && setAnswer({ key, found: here ? "here" : "gone" }),
      (err: unknown) => live && setAnswer({ key, found: isGone(err) ? "gone" : "here" }),
    );
    return () => {
      live = false;
    };
    // The key says what is asked about; `ask` is a fresh closure each render.
  }, [key]);
  if (key === null) return "here";
  return answer?.key === key ? answer.found : "asking";
}
