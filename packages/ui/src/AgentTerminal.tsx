import { useEffect, useRef, useState, type ReactElement } from "react";
import { m } from "motion/react";
import { summarizeAction } from "@kos/shared";

import { ease, spring } from "./motion.js";

import { api, type BuildRecord, type PendingAction } from "./api.js";
import { ChevronDown, ChevronRight } from "./icons.js";
import { Decision } from "./Decision.js";

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
  result: "←",
  permission: "?",
  done: "✓",
  error: "✗",
};

/** The gist of a tool call, the way a shell prompt shows a command. */
function command(tool: string | undefined, input?: Record<string, unknown>): string {
  if (!input) return tool ?? "";
  const v = (k: string): string | undefined =>
    typeof input[k] === "string" ? (input[k] as string) : undefined;
  const first =
    v("command") ?? v("file_path") ?? v("path") ?? v("pattern") ?? v("url") ?? v("query");
  return first ? `${tool} ${first}` : (tool ?? "");
}

function short(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * One line of the log.
 *
 * A tool call opens to its full arguments and what came back, because the
 * name alone tells you a tool ran and nothing about what it did, which is the
 * difference between a log and a list.
 */
function Line({
  event,
}: {
  event: BuildRecord["events"][number];
}): ReactElement {
  const [open, setOpen] = useState(false);
  const detailed =
    (event.kind === "tool" && event.input) || (event.kind === "result" && event.output);

  const body =
    event.kind === "tool"
      ? command(event.tool, event.input)
      : event.kind === "result"
        ? (event.output ?? event.text).split("\n")[0]?.slice(0, 160)
        : event.text;

  return (
    <div className={`term-line term-line--${event.kind} ${event.isError ? "is-error" : ""}`}>
      <span className="term-time">{clock(event.at)}</span>
      <span className="term-mark">{KIND_MARK[event.kind] ?? "·"}</span>
      <span className="term-body">
        {detailed ? (
          <button type="button" className="term-open" onClick={() => setOpen((v) => !v)}>
            <span className="term-text">{body}</span>
            <span className="term-caret">{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
          </button>
        ) : (
          <span className="term-text">{body}</span>
        )}
        {open && event.input && (
          <pre className="term-detail">{JSON.stringify(event.input, null, 2)}</pre>
        )}
        {open && event.output && <pre className="term-detail">{event.output}</pre>}
      </span>
    </div>
  );
}

const DOING: Record<string, string> = {
  thinking: "thinking",
  writing: "writing",
  calling: "preparing a call",
};

/** The live line: what it is doing, for how long, and the words as they come. */
function Doing({
  phase,
  since,
}: {
  phase: NonNullable<BuildRecord["phase"]>;
  since: number;
}): ReactElement {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  const secs = Math.max(0, Math.round((now - since) / 1000));
  const label = phase.tool
    ? `preparing ${phase.tool}`
    : (DOING[phase.phase] ?? phase.phase);

  return (
    <div className="term-doing">
      <span className="term-time" />
      <span className="term-mark term-spin">●</span>
      <span className="term-body">
        <span className="term-doing-label">
          {label}… <span className="term-doing-secs">{secs}s</span>
        </span>
        {phase.partial && <span className="term-partial">{phase.partial}</span>}
      </span>
    </div>
  );
}

function clock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export function AgentTerminal({
  id,
  onClose,
  onDecide,
  deciding,
}: {
  id: number;
  onClose: () => void;
  onDecide: (pendingId: number, approved: boolean, remember?: boolean) => void;
  deciding: ReadonlySet<number>;
}): ReactElement {
  const [build, setBuild] = useState<BuildRecord | null>(null);
  const [waiting, setWaiting] = useState<PendingAction[]>([]);
  const [say, setSay] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [stick, setStick] = useState(true);
  /** A build log is long and wide; the dialog was neither. */
  const [full, setFull] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    // Streamed, so output appears as it happens rather than in the stutter of
    // a poll. The approvals still come from the endpoint: they change rarely
    // and belong to the queue rather than to the build.
    const source = new EventSource("/api/agents/stream");
    source.onmessage = (e) => {
      try {
        const record = JSON.parse(e.data as string) as BuildRecord;
        if (!cancelled && record.id === id) setBuild(record);
      } catch {
        // A frame we cannot read is one frame, not a broken log.
      }
    };

    const loadAsks = (): void => {
      void api
        .agent(id)
        .then((r) => {
          if (cancelled) return;
          // The stream is the source for the build itself; this only fills in
          // what it has asked for, and seeds the first render.
          setBuild((current) => current ?? r.build);
          setWaiting(r.approvals);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        });
    };
    loadAsks();
    const t = setInterval(loadAsks, 2000);

    return () => {
      cancelled = true;
      source.close();
      clearInterval(t);
    };
  }, [id]);

  // Follow the tail, unless the reader has scrolled up to look at something.
  useEffect(() => {
    if (!stick) return;
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [build?.events.length, stick]);

  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);

  const live = build?.status === "running" || build?.status === "waiting";

  const send = (): void => {
    const text = say.trim();
    if (!text) return;
    setSay("");
    // A finished agent is woken rather than refused: its process is gone but
    // its session is not, so it carries on with what it already worked out
    // instead of reading the folder again from nothing.
    const work = live ? api.sendToAgent(id, text) : api.wakeAgent(id, text);
    void work.catch((err: unknown) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  };

  return (
    /*
     * A drawer rather than a dialog in the middle of the screen.
     *
     * A build log is something you read alongside the list you opened it
     * from, and a centred modal put a wall between the two: it covered the
     * page, and going from one agent to the next meant closing and reopening.
     * Full screen is still a click away for when the log is the whole task.
     */
    <m.div
      className={`term-wrap ${full ? "is-full" : ""}`}
      role="dialog"
      aria-label="Build log"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={ease}
    >
      <div className="term-backdrop" onClick={onClose} />
      <m.div
        className="term"
        initial={{ x: 28, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: 28, opacity: 0 }}
        transition={spring}
      >
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
          <button
            type="button"
            className="btn"
            title={full ? "Back to a window" : "Fill the screen"}
            onClick={() => setFull((v) => !v)}
          >
            {full ? "Shrink" : "Full screen"}
          </button>
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

        {build?.usage && (build.usage.outputTokens > 0 || build.usage.contextTokens > 0) && (
          <div className="term-usage">
            <span title="Sent to the model on the last turn">
              <b>{short(build.usage.contextTokens)}</b> context
            </span>
            <span title="Tokens produced">
              <b>{short(build.usage.outputTokens)}</b> out
            </span>
            <span title="Read from cache rather than re-sent">
              <b>{short(build.usage.cacheReadTokens)}</b> cached
            </span>
            <span>
              <b>{build.usage.turns}</b> turns
            </span>
            {build.usage.costUsd > 0 && (
              <span title="The SDK's own estimate, not a billing statement">
                <b>${build.usage.costUsd.toFixed(3)}</b> est.
              </span>
            )}
            {build.usage.model && <span className="term-usage-model">{build.usage.model}</span>}
          </div>
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
            <Line key={i} event={e} />
          ))}
          {/* What it is doing right now. Between one tool call and the next
              the log is silent, and silence reads exactly like a hang. */}
          {live && build?.phase && build.phase.phase !== "idle" && (
            <Doing phase={build.phase} since={build.phaseSince ?? Date.now()} />
          )}

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
                <span className="term-ask-text">
                  <code>{a.tool}</code> {summarizeAction(a.tool, a.args)}
                  {a.reason && <span className="term-ask-why"> · {a.reason}</span>}
                </span>
                <Decision id={a.id} deciding={deciding} onDecide={onDecide} small />
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
            placeholder={
              live ? "Say something to it…" : "Say something to wake it…"
            }
            onChange={(e) => setSay(e.target.value)}
          />
        </form>
      </m.div>
    </m.div>
  );
}
