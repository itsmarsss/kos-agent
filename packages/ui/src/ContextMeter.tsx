import { useEffect, useState, type ReactElement } from "react";

import { api, type ContextUse } from "./api.js";

/**
 * How full this conversation's context is.
 *
 * The number is the provider's own count of what the last turn was sent, not
 * an estimate from character counts, so it is the same number the model saw.
 * When the model's window is known it becomes a proportion; when it is not,
 * the count is shown on its own rather than a proportion of a guess.
 *
 * It reads as a warning past three quarters, because that is the point where
 * the next long turn starts pushing the beginning of the conversation out and
 * `/compact` is the thing to do about it.
 */

export function ContextMeter({
  conversationId,
  /** Bumped by the caller when a turn finishes, so the figure keeps up. */
  refreshKey,
}: {
  conversationId: string;
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
        // A missing figure is not worth an error in the header; the meter
        // simply does not appear.
        if (!cancelled) setUse(null);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, refreshKey]);

  if (!use?.last) return null;

  const used = use.last.inputTokens;
  const shown = used < 1000 ? `${used}` : `${(used / 1000).toFixed(1)}k`;
  const fraction = use.window ? used / use.window : undefined;
  const level =
    fraction === undefined ? "" : fraction > 0.75 ? " is-high" : fraction > 0.5 ? " is-mid" : "";

  return (
    <div
      className={`ctx${level}`}
      title={
        use.window
          ? `Last turn sent ${used.toLocaleString()} of ${use.window.toLocaleString()} tokens. /compact to summarise the history.`
          : `Last turn sent ${used.toLocaleString()} tokens. The window for ${use.last.model} is not known here, so no percentage is shown.`
      }
    >
      {fraction !== undefined && (
        <span className="ctx-track" aria-hidden="true">
          <span
            className="ctx-fill"
            style={{ width: `${Math.min(100, fraction * 100).toFixed(1)}%` }}
          />
        </span>
      )}
      <span className="ctx-text">
        {shown} context
        {fraction !== undefined && ` · ${Math.round(fraction * 100)}%`}
      </span>
    </div>
  );
}
