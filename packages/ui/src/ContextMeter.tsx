import { useEffect, useState, type ReactElement } from "react";

import { api, type ContextUse } from "./api.js";

/**
 * How full this conversation is.
 *
 * Two different limits apply and only one of them is always knowable, so the
 * meter shows the one that binds:
 *
 * - **KOS's own retention.** History is trimmed to a character budget and a
 *   number of exchanges, after which the oldest turns fall off the front. This
 *   is a KOS setting, so it is known for every model, and on a large modern
 *   context window it is what runs out first.
 * - **The model's window**, when it is known. Reported as a second figure
 *   rather than the headline, because for most models here it is not known and
 *   a bare "2%" said nothing about the trimming that was about to happen.
 *
 * The earlier version showed only the model window, so on a model with no
 * known window it rendered a token count with no percentage: a number with
 * nothing to compare it to, which is what "does not show how much is used up"
 * meant.
 */

function short(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function ContextMeter({
  conversationId,
  refreshKey,
}: {
  conversationId: string;
  /** Bumped by the caller when a turn finishes, so the figure keeps up. */
  refreshKey?: number;
}): ReactElement | null {
  const [use, setUse] = useState<ContextUse | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .context(conversationId)
      .then((r) => {
        if (!cancelled) setUse(r);
      })
      .catch(() => {
        if (!cancelled) setUse(null);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, refreshKey]);

  if (!use?.history || use.history.historyChars <= 2) return null;

  const { historyChars, maxChars, exchanges, maxExchanges } = use.history;
  // Whichever budget is closer to being spent is the one worth showing: a
  // short conversation of enormous tool results runs out of characters, and a
  // long one of one-liners runs out of exchanges.
  const byChars = historyChars / maxChars;
  const byExchanges = exchanges / maxExchanges;
  const fraction = Math.min(1, Math.max(byChars, byExchanges));
  const level = fraction > 0.85 ? " is-high" : fraction > 0.6 ? " is-mid" : "";

  const window = use.window;
  const windowPart =
    window && use.last
      ? ` Last turn sent ${use.last.inputTokens.toLocaleString()} tokens of a ${short(window)} window.`
      : use.last
        ? ` Last turn sent ${use.last.inputTokens.toLocaleString()} tokens; the window for ${use.last.model} is not known here.`
        : "";

  return (
    <div
      className={`ctx${level}`}
      title={
        `Keeping ${historyChars.toLocaleString()} of ${maxChars.toLocaleString()} characters ` +
        `and ${exchanges} of ${maxExchanges} exchanges. Past either, the oldest turns ` +
        `drop off; /compact turns them into a summary instead.${windowPart}`
      }
    >
      <span className="ctx-track" aria-hidden="true">
        <span className="ctx-fill" style={{ width: `${(fraction * 100).toFixed(1)}%` }} />
      </span>
      <span className="ctx-text">
        {Math.round(fraction * 100)}% full
        <span className="ctx-detail">
          {" · "}
          {exchanges}/{maxExchanges} turns
        </span>
      </span>
    </div>
  );
}
