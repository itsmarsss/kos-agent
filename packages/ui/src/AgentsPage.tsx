import { useEffect, useState, type ReactElement } from "react";

import { AnimatePresence, m } from "motion/react";

import { AgentTerminal } from "./AgentTerminal.js";
import { Drawer } from "./Drawer.js";
import { PageHead } from "./PageHead.js";
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
  onAgain,
  onForget,
}: {
  build: BuildRecord;
  onStop: (id: number) => void;
  onInterrupt: (id: number) => void;
  onOpen: (id: number) => void;
  /** Run the same task in the same folder again. */
  onAgain: (build: BuildRecord) => void;
  /** Remove a finished agent from the list. */
  onForget: (id: number) => void;
}): ReactElement {
  const [now, setNow] = useState(() => Date.now());
  const live = build.status === "running" || build.status === "waiting";

  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);

  return (
    // The whole card opens it. The card was inert except for one button on
    // it, which is not how anything else in the app behaves.
    <article
      className={`agent agent--${build.status}`}
      onClick={() => onOpen(build.id)}
    >
      <header className="agent-head">
        <span className="agent-toggle">
          <span className={`agent-dot agent-dot--${build.status}`} />
          <span className="agent-dir">{build.dir}</span>
          <span className="agent-state">{LABEL[build.status] ?? build.status}</span>
        </span>
        <span className="agent-time">
          {elapsed(build.startedAt, build.endedAt ?? now)}
        </span>
        {live && (
          <>
            <button
              type="button"
              className="btn"
              title="Stop what it is doing now, but keep it going so you can redirect it"
              onClick={(e) => {
                e.stopPropagation();
                onInterrupt(build.id);
              }}
            >
              Interrupt
            </button>
            <button
              type="button"
              className="btn btn--danger"
              onClick={(e) => {
                e.stopPropagation();
                onStop(build.id);
              }}
            >
              Stop
            </button>
          </>
        )}
        {!live && (
          <>
            <button
              type="button"
              className="btn"
              title="Run the same task in the same folder again"
              onClick={(e) => {
                e.stopPropagation();
                onAgain(build);
              }}
            >
              Again
            </button>
            <button
              type="button"
              className="btn btn--danger-ghost"
              title="Remove it from this list. The files it wrote stay."
              onClick={(e) => {
                e.stopPropagation();
                onForget(build.id);
              }}
            >
              Forget
            </button>
          </>
        )}
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
  onDecide: (pendingId: number, approved: boolean, remember?: boolean) => void;
  deciding: ReadonlySet<number>;
  openId?: number;
}): ReactElement {
  const [builds, setBuilds] = useState<BuildRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The build being read as a terminal, if any. */
  const [reading, setReading] = useState<number | null>(openId ?? null);
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({ dir: "", task: "" });
  const [folders, setFolders] = useState<string[]>([]);

  useEffect(() => {
    if (!starting || folders.length > 0) return;
    void api
      .folders()
      .then((r) => setFolders(r.folders))
      .catch(() => setFolders([]));
  }, [starting, folders.length]);

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
      <PageHead
        title="Agents"
        subtitle="Coding sub-agents working inside the workspace. Each is confined to its own folder, and every shell command comes back to you."
        actions={
          /* Starting one was only possible by asking KOS to, which is a long
             way round when you already know the folder and the job. */
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => setStarting(true)}
          >
            New agent
          </button>
        }
      />

      {/* A drawer, like the build log it will become and like everything
          else with more than a field or two in it. */}
      <Drawer
        open={starting}
        title="Start a coding agent"
        subtitle="It works inside one folder, and asks before anything outside it"
        onClose={() => setStarting(false)}
      >
        <form
          className="agent-start"
          onSubmit={(e) => {
            e.preventDefault();
            const dir = draft.dir.trim();
            const task = draft.task.trim();
            if (!dir || !task) return;
            setBusy(true);
            void api
              .startAgent(dir, task)
              .then(() => {
                setStarting(false);
                setDraft({ dir: "", task: "" });
                load();
              })
              .catch((err: unknown) =>
                setError(err instanceof Error ? err.message : String(err)),
              )
              .finally(() => setBusy(false));
          }}
        >
          <label className="kos-field">
            <span className="kos-field-label">Folder</span>
            {/* A list of what is already there, and still typeable: the
                folder may not exist yet. A free-text box gave no idea what
                the paths in this workspace even look like. */}
            <input
              className="kos-input"
              autoFocus
              list="agent-folders"
              placeholder="sites/expenses"
              value={draft.dir}
              onChange={(e) => setDraft({ ...draft, dir: e.target.value })}
            />
            <datalist id="agent-folders">
              {folders.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
            {folders.length > 0 && (
              <div className="agent-folder-picks">
                {folders.slice(0, 8).map((f) => (
                  <button
                    key={f}
                    type="button"
                    className={`ops-btn ${draft.dir === f ? "ops-btn--primary" : ""}`}
                    onClick={() => setDraft({ ...draft, dir: f })}
                  >
                    {f}
                  </button>
                ))}
              </div>
            )}
            <span className="hint">
              Workspace-relative, created if missing. The agent works only in
              here; anything outside it comes back to you for approval.
            </span>
          </label>
          <label className="kos-field">
            <span className="kos-field-label">Task</span>
            <textarea
              className="ops-textarea"
              rows={5}
              placeholder="What to build, in full."
              value={draft.task}
              onChange={(e) => setDraft({ ...draft, task: e.target.value })}
            />
            <span className="hint">
              It cannot see this page or any chat, so say everything it needs
              to know.
            </span>
          </label>
          <div className="agent-start-actions">
            <button
              type="submit"
              className="btn btn--primary"
              disabled={busy || !draft.dir.trim() || !draft.task.trim()}
            >
              {busy ? "Starting…" : "Start"}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setStarting(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      </Drawer>

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
            onAgain={(b) => {
              setDraft({ dir: b.dir, task: b.task });
              setStarting(true);
            }}
            onForget={(id) => act(api.forgetAgent(id))}
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
