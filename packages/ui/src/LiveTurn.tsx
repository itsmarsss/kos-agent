import { useEffect, useState, type ReactElement } from "react";

import { Markdown } from "./Markdown.js";
import type { Live } from "./progress.js";

/**
 * A turn while it is still happening.
 *
 * The reply streams in as it is written, the model's own account of what it is
 * working out sits above it, and the tool it is running replaces both while it
 * runs. When there is nothing yet to show, the elapsed time does the work: a
 * static word for twenty seconds reads as a hang.
 */

/** Last line of a reasoning summary: the part that is about right now. */
function currentThought(reasoning: string): string {
  const clean = reasoning.replace(/\*\*/g, "").trim();
  if (!clean) return "";
  const lines = clean.split("\n").filter((l) => l.trim() !== "");
  return lines.at(-1)?.trim() ?? "";
}

function Elapsed({ since }: { since: number }): ReactElement {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="live-elapsed">{Math.max(0, Math.round((now - since) / 1000))}s</span>;
}

export function LiveTurn({ live }: { live: Live }): ReactElement {
  const thought = currentThought(live.reasoning);

  return (
    <div className="bubble bubble--kos live">
      <div className="live-head">
        <span className="live-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="live-what">{live.step ?? "thinking"}</span>
        <Elapsed since={live.since} />
      </div>

      {/* Only while there is no reply yet: once the answer starts arriving,
          the working-out is no longer the interesting part. */}
      {!live.text && thought && <div className="live-thought">{thought}</div>}

      {live.text && (
        <div className="live-text">
          <Markdown text={live.text} />
        </div>
      )}
    </div>
  );
}
