import { useEffect, useRef, type ReactElement } from "react";
import { summarizeAction } from "@kos/shared";

import { AskSteps, Count, Empty, Tag } from "@kos/kit";

import { api, type FailingJob, type InboxData } from "./api.js";
import { Decision } from "./Decision.js";
import { InboxDecided } from "./InboxDecided.js";
import { MemoryDecision } from "./MemoryPage.js";
import { PageHead } from "./PageHead.js";
import { agoWords as ago } from "./schedulewords.js";
import { ActivityDot, fixLabel } from "./StatusDot.js";

/**
 * Everything waiting on you, with the buttons to clear it.
 *
 * Tool approvals were on the overview and in the chat, memory's open
 * questions were on the Memory page, failing jobs were in a panel, and the
 * banner that said "needs you" counted only the first. For KOS to be left
 * running on its own, there has to be one place that says what it is stuck
 * on, and this is it.
 */

/** How long an ask has left before it lapses on its own. */
function lapses(ts: number): string {
  const mins = Math.round((ts - Date.now()) / 60000);
  if (mins < 1) return "lapses any moment";
  if (mins < 60) return `lapses in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `lapses in ${hours}h`;
  return `lapses in ${Math.round(hours / 24)}d`;
}

export function InboxPage({
  data,
  highlight,
  deciding,
  onDecide,
  onOpenChat,
  onOpenBrowser,
  onDismissFailure,
  onOpenFailure,
  onFixFailure,
  onChanged,
}: {
  data: InboxData | null;
  /** An approval to show first, by number: the one a link in a chat pointed at, waiting or decided. */
  highlight?: number;
  deciding: ReadonlySet<number>;
  onDecide: (id: number, approved: boolean, remember?: boolean) => void;
  onOpenChat: (id: string) => void;
  /** Show the browser window, where a handoff is done by hand. */
  onOpenBrowser?: () => void;
  onDismissFailure: (key: string) => void;
  onOpenFailure: (key: string) => void;
  onFixFailure: (failure: FailingJob) => void;
  /** Something was settled here; the shell re-reads its counts. */
  onChanged: () => void;
}): ReactElement {
  const approvals = data?.approvals ?? [];
  const highlit = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    highlit.current?.scrollIntoView({ block: "center" });
  }, [highlight, approvals.length]);
  const decisions = data?.decisions ?? [];
  const failures = data?.failures ?? [];
  const suggestions = data?.suggestions ?? [];
  const total = approvals.length + decisions.length + failures.length + suggestions.length;

  return (
    <div className="inbox">
      <PageHead
        title="Inbox"
        subtitle={
          total === 0
            ? "Nothing is waiting on you."
            : `${total} ${total === 1 ? "thing" : "things"} KOS cannot settle on its own.`
        }
      />

      {data && total === 0 && (
        <Empty title="All clear." className="inbox-clear">
          Tool calls that need a yes, memory questions the tidy job could not settle, and jobs failing now will show up here.
        </Empty>
      )}

      {approvals.length > 0 && (
        <section className="inbox-group inbox-group--asks">
          <h2 className="inbox-group-title">
            Tool approvals <Count n={approvals.length} />
          </h2>
          <ul className="panel-list inbox-box">
            {approvals.map((a) => (
              <li key={a.id} ref={a.id === highlight ? highlit : undefined} className={`panel-approval inbox-approval${a.id === highlight ? " is-highlit" : ""}`}>
                <span className="panel-row-main">
                  {/* Who is asking, first: a command with no one behind it is a yes to anyone. */}
                  {a.asker && <span className="inbox-asker">{a.asker} asks</span>}
                  {a.why && <span className="inbox-said">{a.why}</span>}
                  {a.summary ?? summarizeAction(a.tool, a.args)}
                  <AskSteps mechanics={a.mechanics} tool={a.tool} args={a.args} />
                  <code className="panel-approval-tool">{a.tool}</code>
                  {a.reason && <span className="inbox-why">{a.reason}</span>}
                  {a.picture && <img className="approval-pic" src={`/api/approvals/${a.id}/picture`} alt="The page this would act on" />}
                  {a.rule?.scope?.startsWith("site:") && <span className="inbox-meta">Always would trust {a.rule.scope.slice(5)} for every browser action.</span>}
                  <span className="inbox-meta">
                    {ago(a.requestedAt)}
                    {a.expiresAt !== undefined && ` · ${lapses(a.expiresAt)}`}
                    {a.conversationId && (
                      <>
                        {" · "}
                        <button type="button" className="link" onClick={() => onOpenChat(a.conversationId!)}>
                          open the chat
                        </button>
                      </>
                    )}
                  </span>
                </span>
                <span className="panel-approval-actions">
                  {a.tool === "browser.handoff" && onOpenBrowser && (
                    <button type="button" className="btn btn--sm" onClick={onOpenBrowser}>
                      Open the browser
                    </button>
                  )}
                  <Decision
                    id={a.id}
                    deciding={deciding}
                    onDecide={onDecide}
                    small
                    {...(a.tool === "browser.handoff" ? { labels: { yes: "Done", no: "Can't" }, noRemember: true } : {})}
                  />
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {decisions.length > 0 && (
        <section className="inbox-group">
          <h2 className="inbox-group-title">
            Memory decisions <Count n={decisions.length} />
          </h2>
          <p className="hint">Only what KOS was not sure enough to settle itself; each leads with what it leans to. Keeping one side archives the other; promoting writes the claim global. Either is on the record as yours.</p>
          <div className="inbox-box">
            {decisions.map((item) => (
              <MemoryDecision key={item.id} item={item} onResolved={onChanged} />
            ))}
          </div>
        </section>
      )}

      {suggestions.length > 0 && (
        <section className="inbox-group">
          <h2 className="inbox-group-title">
            Suggestions <Count n={suggestions.length} />
          </h2>
          <p className="hint">Things KOS thinks it could make reusable. Nothing happens until you say so; accepting opens a chat that carries it out, with the usual approvals.</p>
          <div className="inbox-box">
            {suggestions.map((s) => (
              <div key={s.id} className="inbox-suggestion">
                <div className="inbox-suggestion-main">
                  <span className="panel-row-main">
                    <Tag>{s.kind}</Tag> {s.title}
                  </span>
                  <span className="inbox-why">{s.detail}</span>
                </div>
                <span className="panel-approval-actions">
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() =>
                      void api.resolveImprovement(s.id, "accept").then((r) => {
                        onChanged();
                        if (r.conversationId) onOpenChat(r.conversationId);
                      })
                    }
                  >
                    Do it
                  </button>
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => void api.resolveImprovement(s.id, "dismiss").then(onChanged)}>
                    Dismiss
                  </button>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {failures.length > 0 && (
        <section className="inbox-group">
          <h2 className="inbox-group-title">
            Failing now <Count n={failures.length} />
          </h2>
          <ul className="panel-list inbox-box">
            {failures.map((f) => (
              <li key={f.key} className="inbox-failure">
                <button type="button" className="panel-row is-error" onClick={() => onOpenFailure(f.key)}>
                  <span className="panel-row-main">
                    <span className="fail-label">{f.label}</span>
                    <span className="fail-why">{f.error ?? "failed"}</span>
                  </span>
                  <span className="panel-row-side">
                    {f.streak > 1 ? `${f.streak}x · ` : ""}
                    since {ago(f.since)}
                  </span>
                </button>
                <span className="panel-approval-actions">
                  {f.fixing ? (
                    /* Already on it: say so and open that chat, rather than
                       offer to start a second look at the same thing. */
                    <button
                      type="button"
                      className="btn btn--sm btn--onit"
                      onClick={() => onOpenChat(f.fixing!.conversationId)}
                      title="Open the chat where KOS is looking into this"
                    >
                      <ActivityDot activity={f.fixing.activity} />
                      {fixLabel(f.fixing.activity)}
                    </button>
                  ) : (
                    <button type="button" className="btn btn--sm" onClick={() => onFixFailure(f)}>
                      Put KOS on it
                    </button>
                  )}
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => onDismissFailure(f.key)}>
                    Dismiss
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <InboxDecided {...(data?.decided ? { mark: data.decided } : {})} {...(highlight !== undefined ? { highlight } : {})} onOpenChat={onOpenChat} />
    </div>
  );
}
