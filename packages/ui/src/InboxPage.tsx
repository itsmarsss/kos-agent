import type { ReactElement } from "react";
import { summarizeAction } from "@kos/shared";

import type { FailingJob, InboxData } from "./api.js";
import { Decision } from "./Decision.js";
import { MemoryDecision } from "./MemoryPage.js";
import { PageHead } from "./PageHead.js";

/**
 * Everything waiting on you, with the buttons to clear it.
 *
 * Tool approvals were on the overview and in the chat, memory's open
 * questions were on the Memory page, failing jobs were in a panel, and the
 * banner that said "needs you" counted only the first. For KOS to be left
 * running on its own, there has to be one place that says what it is stuck
 * on, and this is it.
 */

function ago(ts: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function InboxPage({
  data,
  deciding,
  onDecide,
  onOpenChat,
  onDismissFailure,
  onOpenFailure,
  onFixFailure,
  onChanged,
}: {
  data: InboxData | null;
  deciding: ReadonlySet<number>;
  onDecide: (id: number, approved: boolean, remember?: boolean) => void;
  onOpenChat: (id: string) => void;
  onDismissFailure: (key: string) => void;
  onOpenFailure: (key: string) => void;
  onFixFailure: (failure: FailingJob) => void;
  /** Something was settled here; the shell re-reads its counts. */
  onChanged: () => void;
}): ReactElement {
  const approvals = data?.approvals ?? [];
  const decisions = data?.decisions ?? [];
  const failures = data?.failures ?? [];
  const total = approvals.length + decisions.length + failures.length;

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
        <div className="inbox-clear">
          <p className="inbox-clear-title">All clear.</p>
          <p className="hint">
            Tool calls that need a yes, memory questions the tidy job could not settle, and jobs failing
            now will show up here.
          </p>
        </div>
      )}

      {approvals.length > 0 && (
        <section className="inbox-group">
          <h2 className="inbox-group-title">
            Tool approvals <span className="panel-count">{approvals.length}</span>
          </h2>
          <ul className="panel-list">
            {approvals.map((a) => (
              <li key={a.id} className="panel-approval inbox-approval">
                <span className="panel-row-main">
                  {summarizeAction(a.tool, a.args)}
                  <code className="panel-approval-tool">{a.tool}</code>
                  {a.reason && <span className="inbox-why">{a.reason}</span>}
                  <span className="inbox-meta">
                    {ago(a.requestedAt)}
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
                  <Decision id={a.id} deciding={deciding} onDecide={onDecide} small />
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {decisions.length > 0 && (
        <section className="inbox-group">
          <h2 className="inbox-group-title">
            Memory decisions <span className="panel-count">{decisions.length}</span>
          </h2>
          <p className="hint">Keeping one side archives the other; promoting writes the claim global. Both are on the record as yours.</p>
          {decisions.map((item) => (
            <MemoryDecision key={item.id} item={item} onResolved={onChanged} />
          ))}
        </section>
      )}

      {failures.length > 0 && (
        <section className="inbox-group">
          <h2 className="inbox-group-title">
            Failing now <span className="panel-count">{failures.length}</span>
          </h2>
          <ul className="panel-list">
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
                  <button type="button" className="btn btn--sm" onClick={() => onFixFailure(f)}>
                    Put KOS on it
                  </button>
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => onDismissFailure(f.key)}>
                    Dismiss
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
