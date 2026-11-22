import { useEffect, useRef, type ReactElement } from "react";

import { Count, EmptyState, StepPicture, Tag } from "@kos/kit";

import { api, type FailingJob, type InboxData } from "./api.js";
import { InboxDecided } from "./InboxDecided.js";
import { MemoryDecision } from "./MemoryPage.js";
import { PictureGallery } from "./Lightbox.js";
import { PageHead } from "./PageHead.js";
import { PendingAsk } from "./PendingAsk.js";
import { timeWords as ago } from "@kos/shared";
import { ActivityDot, fixLabel } from "./StatusDot.js";
import { Signed } from "./signed.js";

/**
 * Everything waiting on you, with the buttons to clear it.
 *
 * Tool approvals were on the overview and in the chat, memory's open
 * questions were on the Memory page, failing jobs were in a panel, and the
 * banner that said "needs you" counted only the first. For KOS to be left
 * running on its own, there has to be one place that says what it is stuck
 * on, and this is it.
 */

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
  onDecide: (id: number, approved: boolean, remember?: boolean, code?: string) => void;
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
          // Empty, the box below says so; a line here too said it twice.
          total === 0 ? undefined : `${total} ${total === 1 ? "thing" : "things"} KOS cannot settle on its own.`
        }
      />

      {data && total === 0 && (
        <EmptyState title="Nothing is waiting on you." className="inbox-clear">
          Tool calls that need a yes, memory questions Tidy could not settle, and jobs failing now will show up here.
        </EmptyState>
      )}

      {approvals.length > 0 && (
        <section className="inbox-group inbox-group--asks">
          <h2 className="inbox-group-title">
            Approvals <Count n={approvals.length} />
          </h2>
          <PictureGallery>
          <ul className="panel-list ask-list">
            {approvals.map((a) => (
              <li key={a.id} ref={a.id === highlight ? highlit : undefined} className={`inbox-approval${a.id === highlight ? " is-highlit" : ""}`}>
                <PendingAsk
                  ask={a}
                  deciding={deciding}
                  onDecide={onDecide}
                  bare
                  meta={
                    <>
                      Asked {ago(a.requestedAt)}
                      {a.conversationId && (
                        <>
                          {" · "}
                          <button type="button" className="link" onClick={() => onOpenChat(a.conversationId!)}>
                            Open the chat
                          </button>
                        </>
                      )}
                    </>
                  }
                  extra={
                    /* A handoff in the owner's Chrome is theirs already: KOS's window has nothing of it to show. */
                    a.tool === "browser.handoff" && !a.yours && onOpenBrowser ? (
                      <button type="button" className="btn" onClick={onOpenBrowser}>
                        Open the browser
                      </button>
                    ) : undefined
                  }
                >
                  {a.picture && <Signed url={`/api/approvals/${a.id}/picture`}>{(src) => <StepPicture src={src} alt="The page this would act on" caption={a.title ?? a.summary ?? a.tool} />}</Signed>}
                </PendingAsk>
              </li>
            ))}
          </ul>
          </PictureGallery>
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

      {/* Drawn once what waits is here: drawn before it, a link's row was scrolled to and then pushed down the page. */}
      {data && <InboxDecided {...(data.decided ? { mark: data.decided } : {})} {...(highlight !== undefined ? { highlight } : {})} onOpenChat={onOpenChat} />}
    </div>
  );
}
