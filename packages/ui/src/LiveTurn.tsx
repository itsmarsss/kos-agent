import { useEffect, useState, type ReactElement } from "react";
import { AnimatePresence, m } from "motion/react";

import { Markdown } from "./Markdown.js";
import { listItem } from "./motion.js";
import { hrefFor } from "./routes.js";
import { Thinking } from "./Thinking.js";
import { ToolCall } from "./ToolCall.js";
import type { CongregationMember, Live, LiveStep } from "./progress.js";

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

/** The one-line account of a roster: who is done, who is still at it. */
export function congregationHead(members: CongregationMember[]): string {
  const done = members.filter((m) => m.status === "done").length;
  const failed = members.filter((m) => m.status === "failed").length;
  const working = members.length - done - failed;
  const noun = members.length === 1 ? "agent" : "agents";
  const tail = failed > 0 ? `, ${failed} failed` : "";
  if (working === 0) return `Gathered from ${members.length} ${noun}${tail}`;
  return `Gathering from ${members.length} ${noun}, ${done} done, ${working} working${tail}`;
}

/**
 * Who this turn is waiting on. Each row links to the member's own chat, so
 * the owner can watch any one of them rather than only the count.
 */
function Congregation({ members }: { members: CongregationMember[] }): ReactElement {
  return (
    <div className="congregation">
      <div className="congregation-head">{congregationHead(members)}</div>
      {members.map((member) => (
        <div className="congregation-row" key={member.id}>
          <a className="congregation-title" href={hrefFor({ name: "chats", id: member.id })}>
            {member.title}
          </a>
          {member.status === "done" ? (
            <span className="chats-badge">done</span>
          ) : (
            <span
              className={`chats-flag ${member.status === "failed" ? "chats-flag--needs-you" : "chats-flag--working"}`}
            >
              {member.status}
            </span>
          )}
        </div>
      ))}
    </div>
  );
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
  const answering = live.text !== "" && !live.resumed;

  /*
   * A turn that has ended is still on screen, holding its steps until the
   * transcript that contains them arrives. What it must not do is keep
   * saying it is thinking: the work is over, only the handover is not.
   */

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
              variants={listItem}
              initial="hidden"
              animate="show"
              layout="position"
            >
              {/* The same component the finished transcript uses, so a call
                  can be opened for its arguments and result while it is still
                  running, and nothing rearranges when the turn lands. */}
              <ToolCall
                event={{
                  kind: "tool",
                  name: step.tool,
                  summary: step.summary,
                  args: step.input ?? {},
                  ...(step.done ? { result: step.result ?? "" } : {}),
                  ...(step.isError ? { isError: true } : {}),
                }}
              />
            </m.div>
          ),
        )}
      </AnimatePresence>

      {/* Above the reply, and kept while it streams: the combined answer is
          written from these, so the reader can see what it was made of. */}
      {live.congregation && <Congregation members={live.congregation.members} />}

      {answering ? (
        // The reply as it is written, in the shape it will keep once it lands.
        <div className="bubble bubble--kos">
          <Markdown text={live.text} />
        </div>
      ) : live.ended ? null : (
        <div className="bubble bubble--kos live">
          <div className="live-head">
            <span className="live-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="live-what">
              {running
                ? `Running ${running.summary}`
                : live.resumed
                  ? "Still working"
                  : "Thinking"}
            </span>
            <Elapsed since={live.since} />
          </div>
        </div>
      )}
    </>
  );
}
