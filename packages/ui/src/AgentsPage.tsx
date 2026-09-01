import { useEffect, useState, type ReactElement } from "react";

import { api, type BuildRecord } from "./api.js";
import { hrefFor } from "./routes.js";

/**
 * What is running inside the workspace.
 *
 * A build is a Claude Code sub-agent working for minutes at a time. Started
 * from a tool call and never mentioned again, the only sign of one was a chat
 * that had gone quiet: no way to see what it was doing, how long it had been
 * at it, or to stop one that had clearly gone wrong.
 *
 * The list is not persisted, and should not be: a build belongs to the process
 * running it, so a list that survived a restart would be a list of agents that
 * no longer exist.
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
  onSend,
  onInterrupt,
}: {
  build: BuildRecord;
  onStop: (id: number) => void;
  onSend: (id: number, text: string) => void;
  onInterrupt: (id: number) => void;
}): ReactElement {
  const [open, setOpen] = useState(build.status === "waiting");
  const [say, setSay] = useState("");
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
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
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
      </header>

      <p className="agent-latest">{build.latest}</p>

      {live && (
        <form
          className="agent-say"
          onSubmit={(e) => {
            e.preventDefault();
            const text = say.trim();
            if (!text) return;
            onSend(build.id, text);
            setSay("");
          }}
        >
          <input
            className="kos-input"
            value={say}
            placeholder="Tell it something: a correction, a constraint, an answer…"
            onChange={(e) => setSay(e.target.value)}
          />
          <button type="submit" className="btn btn--primary" disabled={!say.trim()}>
            Send
          </button>
        </form>
      )}

      {open && (
        <div className="agent-detail">
          <div className="agent-task">
            <span className="agent-label">Asked to</span>
            <p>{build.task}</p>
          </div>

          {build.conversationId && (
            <a
              className="link"
              href={hrefFor({ name: "chats", id: build.conversationId })}
            >
              Open the chat that started it
            </a>
          )}

          {build.files.length > 0 && (
            <div>
              <span className="agent-label">Files</span>
              <ul className="agent-files">
                {build.files.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <span className="agent-label">
              What it has done{build.askedFor > 0 ? ` · asked you ${build.askedFor}×` : ""}
            </span>
            <ol className="agent-events">
              {build.events
                .slice(-40)
                .reverse()
                .map((e, i) => (
                  <li key={i} className={`agent-event agent-event--${e.kind}`}>
                    <span className="agent-event-kind">{e.kind}</span>
                    <span>{e.text}</span>
                  </li>
                ))}
            </ol>
          </div>
        </div>
      )}
    </article>
  );
}

export function AgentsPage(): ReactElement {
  const [builds, setBuilds] = useState<BuildRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    // Polled rather than streamed: a build reports every few seconds at most,
    // and this page is only open when someone is watching one.
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

  const stop = (id: number): void => act(api.stopAgent(id));
  const send = (id: number, text: string): void => act(api.sendToAgent(id, text));
  const interrupt = (id: number): void => act(api.interruptAgent(id));

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
          you for approval. You can talk to one while it works: a correction
          lands before its next step rather than after the whole build.
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
        {builds?.map((b) => (
          <Build
            key={b.id}
            build={b}
            onStop={stop}
            onSend={send}
            onInterrupt={interrupt}
          />
        ))}
      </div>
    </div>
  );
}
