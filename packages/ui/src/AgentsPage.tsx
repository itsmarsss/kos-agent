import { useEffect, useState, type ReactElement } from "react";

import { AnimatePresence, m } from "motion/react";

import { AgentTerminal } from "./AgentTerminal.js";
import { api, type BuildRecord } from "./api.js";
import { listItem } from "./motion.js";

/**
 * What is running inside the workspace.
 *
 * The list answers "is anything happening"; opening one answers "what is it
 * doing", which is the question you have when it looks stuck. The row is
 * deliberately thin: a summary that tried to be a log was neither, showing a
 * dozen truncated lines with no way to read the rest.
 *
 * Not persisted, and should not be: a build belongs to the process running it,
 * so a list that survived a restart would list agents that no longer exist.
 */

const LABEL: Record<string, string> = {
  running: "working",
  waiting: "waiting on you",
  done: "finished",
  failed: "failed",
  stopped: "stopped",
};

function elapsed(from: number, to: number): string {
  const secs = Math.max(0, Math.round((to - from) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function Build({
  build,
  onStop,
  onInterrupt,
  onOpen,
}: {
  build: BuildRecord;
  onStop: (id: number) => void;
  onInterrupt: (id: number) => void;
  onOpen: (id: number) => void;
}): ReactElement {
  const [now, setNow] = useState(() => Date.now());
  const live = build.status === "running" || build.status === "waiting";

  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);

  return (
    <article className={`agent agent--${build.status}`}>
      <header className="agent-head">
        <button
          type="button"
          className="agent-toggle"
          title="Open the full log"
          onClick={() => onOpen(build.id)}
        >
          <span className={`agent-dot agent-dot--${build.status}`} />
          <span className="agent-dir">{build.dir}</span>
          <span className="agent-state">{LABEL[build.status] ?? build.status}</span>
          <span className="agent-time">
            {elapsed(build.startedAt, build.endedAt ?? now)}
          </span>
        </button>
        {live && (
          <>
            <button
              type="button"
              className="btn"
              title="Stop what it is doing now, but keep it going so you can redirect it"
              onClick={() => onInterrupt(build.id)}
            >
              Interrupt
            </button>
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => onStop(build.id)}
            >
              Stop
            </button>
          </>
        )}
        <button type="button" className="btn" onClick={() => onOpen(build.id)}>
          Open
        </button>
      </header>

      <p className="agent-latest">
        {build.phase && build.phase.phase !== "idle" && live ? (
          <span className="agent-doing">
            <span className="term-spin">●</span>{" "}
            {build.phase.tool
              ? `preparing ${build.phase.tool}`
              : build.phase.phase}
            …
          </span>
        ) : null}
        {build.latest}
      </p>

      {/* Thinking and wedged look identical from outside: both say running and
          produce nothing. Silence for minutes is worth naming. */}
      {build.quietFor ? (
        <p className="agent-quiet">
          No output for {Math.round(build.quietFor / 60000)}m. It may be working
          on something long, or it may be stuck — open it to see, or stop it.
        </p>
      ) : null}

      {build.askedFor > 0 && (
        <p className="agent-asked">
          Asked you {build.askedFor} time{build.askedFor === 1 ? "" : "s"}
        </p>
      )}
    </article>
  );
}

export function AgentsPage({
  onDecide,
  deciding,
  /** Opened straight from a link or a search result. */
  openId,
}: {
  onDecide: (pendingId: number, approved: boolean) => void;
  deciding: ReadonlySet<number>;
  openId?: number;
}): ReactElement {
  const [builds, setBuilds] = useState<BuildRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The build being read as a terminal, if any. */
  const [reading, setReading] = useState<number | null>(openId ?? null);

  // Following a link to a different agent opens that one.
  useEffect(() => {
    if (openId !== undefined) setReading(openId);
  }, [openId]);

  const load = (): void => {
    void api
      .agents()
      .then((r) => {
        setBuilds(r.builds);
        setError(null);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, []);

  const act = (work: Promise<{ builds: BuildRecord[] }>): void => {
    void work
      .then((r) => setBuilds(r.builds))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  };

  const active = builds?.filter(
    (b) => b.status === "running" || b.status === "waiting",
  );

  return (
    <div className="agents">
      <header className="agents-head">
        <h1>Agents</h1>
        <p className="hint">
          Coding sub-agents working inside the workspace. Each is confined to
          its own folder, and every shell command it wants to run comes back to
          you. Open one to read its log and talk to it.
        </p>
      </header>

      {error && (
        <p className="ops-alert ops-alert--err" role="alert">
          {error}
        </p>
      )}

      {builds && builds.length === 0 && (
        <p className="hint">
          Nothing running. KOS starts one when a job is bigger than editing a
          file, and it appears here while it works.
        </p>
      )}

      {active && active.length === 0 && builds && builds.length > 0 && (
        <p className="hint">Nothing running now. Recent builds below.</p>
      )}

      <div className="agents-list">
        <AnimatePresence initial={false}>
        {builds?.map((b) => (
          <m.div key={b.id} layout variants={listItem} initial="hidden" animate="show" exit="exit">
          <Build
            build={b}
            onStop={(id) => act(api.stopAgent(id))}
            onInterrupt={(id) => act(api.interruptAgent(id))}
            onOpen={setReading}
          />
          </m.div>
        ))}
        </AnimatePresence>
      </div>

      {/* Presence so the drawer can animate out; returning null on close
          skips the exit entirely and it vanishes instead. */}
      <AnimatePresence>
        {reading !== null && (
          <AgentTerminal
            key={reading}
            id={reading}
            onClose={() => setReading(null)}
            onDecide={onDecide}
            deciding={deciding}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
