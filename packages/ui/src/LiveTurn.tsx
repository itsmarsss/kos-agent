import type { ReactElement } from "react";
import { AnimatePresence, m } from "motion/react";

import { Elapsed, listItem, Markdown, Pill, WorkingDots } from "@kos/kit";
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

/** The one-line account of a roster: who is done, who is still at it. */
export function congregationHead(members: CongregationMember[]): string {
  const done = members.filter((m) => m.status === "done").length;
  const failed = members.filter((m) => m.status === "failed").length;
  const working = members.length - done - failed;
  const noun = members.length === 1 ? "chat" : "chats";
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
          <Pill tone={member.status === "done" ? "ok" : member.status === "failed" ? "warn" : "accent"}>{member.status}</Pill>
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
   * The reply streams in under the steps, and the foot stays under all of it
   * until the turn ends. Taken away as soon as words arrived, a turn that said
   * "checking now" and went on working looked finished for as long as the
   * work took. The label only says thinking before anything has been shown:
   * under streaming prose it would say something untrue.
   */
  const answering = live.text !== "" && !live.resumed;
  const what = running
    ? `Running ${running.summary}`
    : answering
      ? "Working"
      : live.resumed
        ? "Still working"
        : "Thinking";

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

      {answering && (
        // The reply as it is written, in the shape it will keep once it lands.
        <div className="bubble bubble--kos">
          <Markdown text={live.text} />
        </div>
      )}

      {/* A turn that has ended stays on screen, holding its steps until the
          transcript that contains them arrives. It must not keep saying it is
          working: the work is over, only the handover is not. */}
      {!live.ended && (
        <div className="bubble bubble--kos live">
          <div className="live-head">
            <WorkingDots />
            <span className="live-what">{what}</span>
            <Elapsed since={live.since} />
          </div>
        </div>
      )}
    </>
  );
}
