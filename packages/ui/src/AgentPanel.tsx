import { useCallback, useEffect, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { Card, Face, lookOf, moodOf, NotFound, PaneHead, StatusPill, Tag, When } from "@kos/kit";
import { errorWords, momentWords, timeWords, type State } from "@kos/shared";

import { AgentEditor, titleOf } from "./AgentEditor.js";
import { api, type AgentInfo } from "./api.js";
import { scheduleWords } from "./schedule.js";
import { Drawer } from "./Drawer.js";
import { ConfirmButton } from "./kit.js";
import { panelFrame } from "./paneldrawer.js";
import { ProjectExplorer } from "./ProjectExplorer.js";
import { hrefFor } from "./routes.js";
import { groupsOf } from "./ToolPicker.js";
import { lastRunWords, runDays, WEEK } from "./schedulewords.js";

/**
 * The column beside a blob's thread: who it is, how it is doing,
 * when it runs, what it may reach, and what is in its folder. The thread
 * is where the agent is talked to; this is where it is kept. The column
 * takes the agent's own colour, so each one's page is its own.
 */

export interface AgentPanelProps {
  name: string;
  onOpenFile: (path: string) => void;
  onChanged: () => void;
  /** Ask KOS about files in the folder, in this chat. */
  onAskAboutFiles?: (paths: string[]) => void;
  onError: (message: string) => void;
  onNotice: (text: string) => void;
  /** The agent was removed; the page it sat on has nothing left to show. */
  onRemoved: () => void;
  hidden?: boolean;
  /** Drawn as a drawer over the chat, where the page has no room for its column: a modal while it is. */
  modal?: boolean;
  /** Shuts the drawer: its ×, as a phone has no room beside it for the toggle that opened it. */
  onClose?: () => void;
  /** The artifacts of the projects it works in, listed under its folder. */
  rail?: ReactNode;
}

const POLL_MS = 5000;

/** How each state reads as a pill. */
/** How the blob is doing, as the state its pill draws. */
const HERO_STATE = { working: "running", "needs-you": "waiting", error: "failed", asleep: "off", idle: "idle" } as const satisfies Record<string, State>;

/** How the agent is doing, in a line, with a tone for the dot beside it. */
export function stateOf(a: AgentInfo, paused: boolean): { tone: "working" | "needs-you" | "error" | "asleep" | "idle"; text: string } {
  const t = a.thread;
  if (t?.activity === "working") return { tone: "working", text: "Working now" };
  if (t?.activity === "needs-you") return { tone: "needs-you", text: "Waiting on you" };
  if (t?.activity === "error") return { tone: "error", text: `Last turn failed${t.lastError ? `: ${errorWords(t.lastError)}` : ""}` };
  // The pill beside it says Off or Quiet; the line says what the pill cannot.
  if (paused) return { tone: "asleep", text: "Its schedule is off" };
  if (t?.lastSaid) return { tone: "idle", text: `Last spoke ${timeWords(t.updatedAt)}` };
  return { tone: "idle", text: "Nothing said yet" };
}

/** What each blob's panel last showed, so opening it again does not pass through "Loading…". */
const remembered = new Map<string, AgentInfo | null>();

export function AgentPanel({ name, onOpenFile, onAskAboutFiles, onChanged, onError, onNotice, onRemoved, hidden = false, modal = false, onClose, rail }: AgentPanelProps): ReactElement {
  const [agent, setAgent] = useState<AgentInfo | null | undefined>(remembered.get(name));
  const [invalidReason, setInvalidReason] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await api.agents();
      const found = r.agents.find((a) => a.name === name) ?? null;
      remembered.set(name, found);
      setAgent(found);
      setInvalidReason(r.invalid.find((i) => i.name === name)?.reason ?? null);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }, [name, onError]);

  // Another blob is another panel: what it last showed, or nothing until read.
  useEffect(() => {
    setAgent(remembered.get(name));
  }, [name]);

  useEffect(() => {
    if (hidden) return;
    void load();
    const t = setInterval(() => {
      if (document.visibilityState !== "hidden") void load();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [load, hidden]);

  const run = async (work: () => Promise<void>, done?: string): Promise<void> => {
    setBusy(true);
    try {
      await work();
      await load();
      onChanged();
      if (done) onNotice(done);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (agent === undefined) {
    return (
      <aside className="project-panel agent-panel" {...panelFrame(hidden, modal)}>
        <p className="ops-muted">Loading…</p>
      </aside>
    );
  }
  if (agent === null) {
    return (
      <aside className="project-panel agent-panel" {...panelFrame(hidden, modal)}>
        {invalidReason ? (
          <>
            <p className="ops-alert ops-alert--err" role="alert">
              {`This blob's file can't be read: ${invalidReason}.`}
            </p>
            <button type="button" className="btn btn--sm" onClick={() => onOpenFile(`blobs/${name}/blob.md`)}>
              Open the file
            </button>
          </>
        ) : (
          <NotFound what="blob" name={name} back={{ label: "Back to Blobs", href: hrefFor({ name: "blobs" }) }} />
        )}
      </aside>
    );
  }

  const paused = Boolean(agent.job && !agent.job.enabled);
  const state = stateOf(agent, paused);
  const hue = lookOf(agent.name, agent.face ?? {}).hue;
  const days = agent.job ? runDays(agent.job.schedule) : null;
  const title = titleOf(agent.name);

  return (
    <aside className="project-panel agent-panel" {...panelFrame(hidden, modal)} aria-label={`${title}, the blob`} style={{ "--blob-h": String(hue) } as CSSProperties}>
      {/* Who it is, as a project's pane says it: its face, its name, how it is doing, what it is for. */}
      <PaneHead
        {...(modal && onClose ? { onClose } : {})}
        mark={<Face seed={agent.name} look={agent.face ?? {}} size={36} mood={moodOf(agent.thread?.activity, { paused })} />}
        title={title}
        sub={state.text}
        pill={<StatusPill state={HERO_STATE[state.tone]} />}
        desc={agent.description}
      >
        <div className="project-head-acts">
          <button type="button" className="btn btn--sm" title="Its folder on the Files page" onClick={() => onOpenFile(agent.folder)}>
            Open in Files
          </button>
        </div>
      </PaneHead>

      <Card title="Schedule" pill={agent.job ? <StatusPill state={paused ? "off" : "on"} /> : undefined}>
        {agent.job ? (
          <>
            <p className="agent-when">
              {scheduleWords(agent.job.schedule)}
            </p>
            {days && (
              <div className="agent-week" aria-label="Days it runs">
                {WEEK.map((d, i) => (
                  <span key={i} className={days.has(i) ? "is-on" : ""} aria-label={days.has(i) ? "runs" : "rests"}>
                    {d}
                  </span>
                ))}
              </div>
            )}
            <ul className="agent-kv">
              <li>
                <span>Next run</span>
                <b>{agent.job.nextRunAt ? momentWords(agent.job.nextRunAt) : paused ? "When it is on" : "On its schedule"}</b>
              </li>
              <li>
                <span>Last run</span>
                <b>{agent.job.lastRunAt ? <When at={agent.job.lastRunAt} /> : lastRunWords(null)}</b>
              </li>
            </ul>
            <div className="agent-acts">
              <button
                type="button"
                className="btn btn--sm"
                disabled={busy}
                title="Run its scheduled prompt now, in its thread"
                onClick={() => void run(() => api.runAgent(agent.name).then(() => undefined), `${title} is running`)}
              >
                Run now
              </button>
              <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void run(() => api.setCronEnabled(agent.job!.id, paused).then(() => undefined), paused ? "Resumed" : "Paused")}>
                {paused ? "Resume" : "Pause"}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="agent-when">On request</p>
            <p className="hint">It works when you speak to it or KOS dispatches it. Edit to give it a schedule.</p>
          </>
        )}
      </Card>

      <Card title="Reach">
        <div className="tags">
          {agent.tools?.length ? (
            groupsOf(agent.tools).map((g) => (
              <Tag key={g.name} title={`${g.line} (${g.families.join(", ")})`}>
                {g.name}
              </Tag>
            ))
          ) : (
            <Tag title="Every tool KOS has">Everything KOS can do</Tag>
          )}
          <Tag title={agent.memory === "own" ? "What it remembers is its own" : "It shares memory with the project it is in, or the global pool"}>{agent.memory === "own" ? "Own memory" : "Shared memory"}</Tag>
          <Tag title={agent.task === "cheap" ? "The cheap model, for routine checks" : "The model for thinking, for work that needs judgement"}>{agent.task === "cheap" ? "Cheap model" : "Thinking model"}</Tag>
          {agent.report === "always" && <Tag title="Each scheduled run's answer is sent to you, tagged as its own">Reports each run</Tag>}
        </div>
      </Card>

      {/* Its folder, browsed in place as a project's is: agent.md says what
          it is, and the rest is what it has made. */}
      <ProjectExplorer label={agent.name} root={agent.folder} upload={(file, dir) => api.uploadFile(dir ? `${agent.folder}/${dir}` : agent.folder, file)} onOpenInFiles={onOpenFile} {...(onAskAboutFiles ? { onAsk: onAskAboutFiles } : {})} onChanged={onChanged} paused={hidden} />

      {rail}

      <footer className="agent-foot">
        <button type="button" className="btn btn--sm" disabled={busy} onClick={() => setEditing(true)}>
          Edit
        </button>
        <ConfirmButton
          label="Delete"
          confirmLabel="Delete for good"
          text={`Delete ${title}? Its thread stays as a chat.`}
          disabled={busy}
          onConfirm={() => {
            void run(async () => {
              await api.deleteAgent(agent.name);
            }, `Removed ${agent.name}; its thread stays as a chat`).then(onRemoved);
          }}
        />
      </footer>

      <Drawer open={editing} title={`Edit ${title}`} subtitle="What you save, it follows from its next run" wide onClose={() => setEditing(false)}>
        {editing && (
          <AgentEditor
            initial={agent}
            onSaved={(saved) => {
              setEditing(false);
              setAgent(saved);
              onChanged();
              onNotice(`Saved ${titleOf(saved.name)}.`);
            }}
            onCancel={() => setEditing(false)}
          />
        )}
      </Drawer>
    </aside>
  );
}
