import { useEffect, useState, type ReactElement } from "react";
import { AnimatePresence, m } from "motion/react";

import { Markdown } from "./Markdown.js";
import { listItem } from "./motion.js";
import { Thinking } from "./Thinking.js";
import type { Live, LiveStep } from "./progress.js";

/**
 * A turn while it is still happening.
 *
 * Each thought and each tool call appears as it occurs, in the same shapes the
 * finished transcript uses, so the turn does not rearrange itself when it
 * lands. The reply streams in underneath.
 */

/** 45s, 3m 20s, 1h 4m. A count that only ever grows in seconds stops reading. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function Elapsed({ since }: { since: number }): ReactElement {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="live-elapsed">{formatElapsed(now - since)}</span>;
}

export function LiveTurn({ live }: { live: Live }): ReactElement {
  const running = live.steps.find(
    (s): s is Extract<LiveStep, { kind: "tool" }> => s.kind === "tool" && !s.done,
  );

  /*
   * Three states, and only one of them is thinking.
   *
   * Once the reply starts arriving the model is writing, not deliberating, and
   * a "thinking" box above streaming prose says something untrue about what is
   * happening. While a tool runs it is the tool that matters, not the wait.
   */
  const answering = live.text !== "";

  return (
    <>
      <AnimatePresence initial={false}>
        {live.steps.map((step, i) =>
          step.kind === "reasoning" ? (
            <m.div
              key={`r${i}`}
              variants={listItem}
              initial="hidden"
              animate="show"
              layout="position"
            >
              <Thinking text={step.text} />
            </m.div>
          ) : (
            <m.div
              key={`t${i}`}
              className={`livetool ${step.done ? "is-done" : ""} ${
                step.isError ? "is-error" : ""
              }`}
              variants={listItem}
              initial="hidden"
              animate="show"
              layout="position"
            >
              <code className="livetool-name">{step.tool}</code>
              <span className="livetool-what">{step.summary}</span>
              <span className="livetool-state">
                {step.done ? (step.isError ? "failed" : "ok") : "…"}
              </span>
            </m.div>
          ),
        )}
      </AnimatePresence>

      {answering ? (
        // The reply as it is written, in the shape it will keep once it lands.
        <div className="bubble bubble--kos">
          <Markdown text={live.text} />
        </div>
      ) : (
        <div className="bubble bubble--kos live">
          <div className="live-head">
            <span className="live-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="live-what">
              {running ? `Running ${running.summary}` : "Thinking"}
            </span>
            <Elapsed since={live.since} />
          </div>
        </div>
      )}
    </>
  );
}
