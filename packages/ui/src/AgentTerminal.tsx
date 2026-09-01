import { useEffect, useRef, useState, type ReactElement } from "react";

import { api, type BuildRecord, type PendingAction } from "./api.js";

/**
 * One build, read like a terminal.
 *
 * The list view answers "is anything running"; this answers "what is it
 * actually doing", which is the question you have when it looks stuck. So the
 * whole stream in order, monospace, newest at the bottom, with the input at
 * the bottom where an input belongs.
 *
 * Its permission requests are decided here too. They used to be visible only
 * from Home, which meant reading a build that had stopped and having to go
 * somewhere else to find out it was waiting on you, and somewhere else again
 * to say yes.
 */

const KIND_MARK: Record<string, string> = {
  text: "»",
  tool: "$",
  permission: "?",
  done: "✓",
  error: "✗",
};

function clock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export function AgentTerminal({
  id,
  onClose,
  onDecide,
}: {
  id: number;
  onClose: () => void;
  onDecide: (pendingId: number, approved: boolean) => void;
}): ReactElement {
  const [build, setBuild] = useState<BuildRecord | null>(null);
  const [waiting, setWaiting] = useState<PendingAction[]>([]);
  const [say, setSay] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [stick, setStick] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      void api
        .agent(id)
        .then((r) => {
          if (cancelled) return;
          setBuild(r.build);
          setWaiting(r.approvals);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        });
    };
    load();
    const t = setInterval(load, 1500);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [id]);

  // Follow the tail, unless the reader has scrolled up to look at something.
  useEffect(() => {
    if (!stick) return;
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [build?.events.length, stick]);

  const live = build?.status === "running" || build?.status === "waiting";

  const send = (): void => {
    const text = say.trim();
    if (!text) return;
    setSay("");
    void api
      .sendToAgent(id, text)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  };

  return (
    <div className="term-wrap" role="dialog" aria-label="Build log">
      <div className="term-backdrop" onClick={onClose} />
      <div className="term">
        <header className="term-head">
          <span className={`agent-dot agent-dot--${build?.status ?? "done"}`} />
          <span className="term-dir">{build?.dir ?? "…"}</span>
          <span className="term-status">{build?.status}</span>
          {live && (
            <>
              <button
                type="button"
                className="btn"
                onClick={() => void api.interruptAgent(id).catch(() => undefined)}
              >
                Interrupt
              </button>
              <button
                type="button"
                className="btn btn--danger"
                onClick={() => void api.stopAgent(id).catch(() => undefined)}
              >
                Stop
              </button>
            </>
          )}
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </header>

        {error && (
          <p className="ops-alert ops-alert--err" role="alert">
            {error}
          </p>
        )}

        {build && (
          <p className="term-task">
            <span className="term-task-label">Asked to</span>
            {build.task}
          </p>
        )}

        <div
          className="term-log"
          ref={logRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            // Within a line of the bottom counts as following it.
            setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
          }}
        >
          {build?.events.length === 0 && (
            <div className="term-line term-line--muted">Nothing logged yet.</div>
          )}
          {build?.events.map((e, i) => (
            <div key={i} className={`term-line term-line--${e.kind}`}>
              <span className="term-time">{clock(e.at)}</span>
              <span className="term-mark">{KIND_MARK[e.kind] ?? "·"}</span>
              <span className="term-text">{e.text}</span>
            </div>
          ))}
          {build && !live && (
            <div className="term-line term-line--done">
              <span className="term-time" />
              <span className="term-mark">■</span>
              <span className="term-text">{build.status}</span>
            </div>
          )}
        </div>

        {waiting.length > 0 && (
          <div className="term-asks">
            {waiting.map((a) => (
              <div className="term-ask" key={a.id}>
                <span className="term-ask-text">{a.reason ?? a.tool}</span>
                <button
                  type="button"
                  className="btn btn--ok"
                  onClick={() => onDecide(a.id, true)}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="btn btn--danger-ghost"
                  onClick={() => onDecide(a.id, false)}
                >
                  Deny
                </button>
              </div>
            ))}
          </div>
        )}

        <form
          className="term-input"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <span className="term-prompt">›</span>
          <input
            value={say}
            disabled={!live}
            placeholder={
              live ? "Say something to it…" : "This build has finished."
            }
            onChange={(e) => setSay(e.target.value)}
          />
        </form>
      </div>
    </div>
  );
}
