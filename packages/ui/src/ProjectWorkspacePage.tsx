import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
  type ReactNode,
} from "react";

import { api, type Conversation, type DirEntry, type ProjectDetail } from "./api.js";
import { readFile, useDropZone } from "./Attachments.js";
import { byAttention } from "./chattree.js";
import { FileIcon, previewable } from "./FileIcon.js";
import { Thumb } from "./FileThumb.js";
import { PageHead } from "./PageHead.js";
import { hrefFor } from "./routes.js";

/**
 * One project's workspace.
 *
 * A project opened as its orchestrator's chat, and everything else about it
 * sat in a drawer off the list. This is the project as a place: the agents
 * working under it, the files and pictures that belong to it, its pages and
 * tables, with the chat one action away. It is also where the owner starts
 * an agent by hand and puts a file in the folder, which before only the
 * orchestrator and an agent's own tools could do.
 */

export interface ProjectWorkspacePageProps {
  slug: string;
  onOpenChat: (id: string) => void;
  onOpenPage: (id: string) => void;
  onOpenFile: (path: string) => void;
  /** Something changed that the rest of the dashboard lists too. */
  onChanged: () => void;
  onError: (message: string) => void;
}

/** How often the page re-reads the project, so an agent's flag keeps up. */
const POLL_MS = 5000;

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function ago(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function Panel({
  title,
  action,
  className,
  children,
  ...rest
}: {
  title: string;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
} & Omit<React.HTMLAttributes<HTMLElement>, "title" | "className" | "children">): ReactElement {
  return (
    <section className={`ops-panel project-ws-panel${className ? ` ${className}` : ""}`} {...rest}>
      <div className="ops-section-head">
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="insp-stat">
      <span className="insp-stat-value">{value}</span>
      <span className="insp-stat-label">{label}</span>
    </div>
  );
}

function AgentRow({ agent, onOpen }: { agent: Conversation; onOpen: (id: string) => void }): ReactElement {
  const flagged = agent.activity !== undefined && agent.activity !== "idle";
  return (
    <li>
      <button type="button" className="project-ws-agent" onClick={() => onOpen(agent.id)}>
        <span className="project-ws-agent-main">
          <span className="project-ws-agent-title">{agent.title}</span>
          {agent.brief && <span className="insp-meta">{agent.brief}</span>}
        </span>
        {flagged ? (
          <span className={`chats-flag chats-flag--${agent.activity}`}>
            {agent.activity === "working" ? "working" : "needs you"}
          </span>
        ) : (
          <span className="insp-meta">{ago(agent.updatedAt)}</span>
        )}
      </button>
    </li>
  );
}

/** The form for an agent the owner starts by hand: a name, and optionally what it is and what to do. */
function NewAgentForm({
  slug,
  onMade,
  onCancel,
  onError,
}: {
  slug: string;
  onMade: (id: string) => void;
  onCancel: () => void;
  onError: (message: string) => void;
}): ReactElement {
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [task, setTask] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    try {
      const made = await api.createProjectAgent(slug, {
        title: title.trim(),
        ...(brief.trim() ? { brief: brief.trim() } : {}),
        ...(task.trim() ? { task: task.trim() } : {}),
      });
      onMade(made.id);
    } catch (err) {
      onError(message(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="project-ws-form" onSubmit={(e) => void submit(e)}>
      <input
        className="chats-search"
        autoFocus
        placeholder="Agent name, e.g. Receipts"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <textarea
        className="ops-textarea"
        rows={2}
        placeholder="Brief (optional): standing instructions for this agent"
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
      />
      <textarea
        className="ops-textarea"
        rows={2}
        placeholder="First task (optional): asked as soon as it starts"
        value={task}
        onChange={(e) => setTask(e.target.value)}
      />
      <div className="project-ws-form-row">
        <button type="button" className="btn btn--sm btn--ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn--sm btn--primary" disabled={!title.trim() || submitting}>
          {submitting ? "Starting…" : "Start agent"}
        </button>
      </div>
    </form>
  );
}

function FileTile({ entry, onOpen }: { entry: DirEntry; onOpen: (path: string) => void }): ReactElement {
  return (
    <a
      className="files-tile"
      href={hrefFor({ name: "files", path: entry.path })}
      title={entry.name}
      onClick={(e) => {
        e.preventDefault();
        onOpen(entry.path);
      }}
    >
      {entry.kind === "file" && previewable(entry.name) ? (
        <Thumb path={entry.path} name={entry.name} />
      ) : (
        <div className="files-thumb">
          <FileIcon name={entry.name} kind={entry.kind} size={30} />
        </div>
      )}
      <span className="files-tile-name">{entry.name}</span>
      <span className="files-tile-meta">{entry.kind === "file" ? bytes(entry.size) : "folder"}</span>
    </a>
  );
}

export function ProjectWorkspacePage({
  slug,
  onOpenChat,
  onOpenPage,
  onOpenFile,
  onChanged,
  onError,
}: ProjectWorkspacePageProps): ReactElement {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  /** How far through a batch of uploads, while one is in flight. */
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setDetail(await api.projectDetail(slug));
      setError(null);
    } catch (err) {
      setError(message(err));
    }
  }, [slug]);

  useEffect(() => {
    setDetail(null);
    setError(null);
    void load();
    // Nothing is fetched for a tab nobody is looking at.
    const t = setInterval(() => {
      if (document.visibilityState !== "hidden") void load();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  /** The project's own chat, made on first use so it opens before it is spoken to. */
  const openChat = (): void => {
    void api
      .projectChat(slug)
      .then((c) => onOpenChat(c.id))
      .catch((err: unknown) => onError(message(err)));
  };

  const upload = async (list: FileList | null): Promise<void> => {
    if (!list?.length || uploading) return;
    const files = Array.from(list);
    setUploading({ done: 0, total: files.length });
    const failed: string[] = [];
    for (const [i, file] of files.entries()) {
      try {
        await api.uploadProjectFile(slug, await readFile(file));
      } catch (err) {
        failed.push(`${file.name}: ${message(err)}`);
      }
      setUploading({ done: i + 1, total: files.length });
    }
    setUploading(null);
    if (failed.length > 0) onError(failed.join(" · "));
    await load();
    onChanged();
  };

  const drop = useDropZone((list) => void upload(list));

  if (error) {
    return (
      <div className="project-ws">
        <a className="ops-back" href={hrefFor({ name: "projects" })}>
          ← Projects
        </a>
        <p className="ops-alert ops-alert--err" role="alert">
          {error}
        </p>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="project-ws">
        <a className="ops-back" href={hrefFor({ name: "projects" })}>
          ← Projects
        </a>
        <p className="ops-muted">Loading…</p>
      </div>
    );
  }

  const { project, tables, pages, sites, files } = detail;
  const agents = [...detail.agents].sort(byAttention);
  const rows = tables.filter((t) => t.rows >= 0).reduce((n, t) => n + t.rows, 0);

  return (
    <div className="project-ws">
      <a className="ops-back" href={hrefFor({ name: "projects" })}>
        ← Projects
      </a>
      <PageHead
        title={project.name}
        subtitle={project.description ? `${project.type} · ${project.description}` : project.type}
        actions={
          <>
            <span className={`ops-status ops-status--${project.status}`}>{project.status}</span>
            <span className="ops-mono hint">{project.slug}</span>
            <button type="button" className="btn btn--sm" onClick={() => onOpenFile(detail.folder)}>
              Folder
            </button>
            <button type="button" className="btn btn--sm btn--primary" onClick={openChat}>
              Open orchestrator chat
            </button>
          </>
        }
      />

      <div className="insp-stats">
        <Stat label="Agents" value={String(agents.length)} />
        <Stat label="Files" value={String(files.length)} />
        <Stat label="Pages" value={String(pages.length)} />
        <Stat label="Tables" value={String(tables.length)} />
        <Stat label="Rows" value={rows.toLocaleString()} />
      </div>

      <div className="project-ws-cols">
        <div className="project-ws-main">
          <Panel
            title="Agents"
            action={
              !adding && (
                <button type="button" className="btn btn--sm" onClick={() => setAdding(true)}>
                  New agent
                </button>
              )
            }
          >
            {adding && (
              <NewAgentForm
                slug={slug}
                onCancel={() => setAdding(false)}
                onError={onError}
                onMade={(id) => {
                  setAdding(false);
                  onChanged();
                  onOpenChat(id);
                }}
              />
            )}
            {agents.length === 0 ? (
              <p className="hint">
                No agents yet. The orchestrator starts them as work comes up, or start one here.
              </p>
            ) : (
              <ul className="project-ws-agents">
                {agents.map((a) => (
                  <AgentRow key={a.id} agent={a} onOpen={onOpenChat} />
                ))}
              </ul>
            )}
          </Panel>

          <Panel
            title="Files & images"
            className={drop.over ? "project-ws-drop is-over" : "project-ws-drop"}
            {...drop.handlers}
            action={
              <>
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={uploading !== null}
                  onClick={() => picker.current?.click()}
                >
                  {uploading ? `Uploading ${uploading.done} of ${uploading.total}…` : "Upload"}
                </button>
                <input
                  ref={picker}
                  type="file"
                  multiple
                  hidden
                  aria-label="Upload files"
                  onChange={(e) => {
                    void upload(e.target.files);
                    // Cleared so picking the same file twice still fires a change.
                    e.target.value = "";
                  }}
                />
              </>
            }
          >
            {files.length === 0 ? (
              <p className="hint">Nothing here yet. Drop files on this panel or upload them.</p>
            ) : (
              <div className="files-grid">
                {files.map((f) => (
                  <FileTile key={f.path} entry={f} onOpen={onOpenFile} />
                ))}
              </div>
            )}
          </Panel>
        </div>

        <aside className="project-ws-side">
          <Panel title="Pages">
            {pages.length === 0 ? (
              <p className="hint">No pages yet.</p>
            ) : (
              <div className="project-ws-chips">
                {pages.map((pg) => (
                  <a
                    key={pg.id}
                    className="ops-page-chip"
                    href={hrefFor({ name: "page", id: pg.id })}
                    onClick={(e) => {
                      e.preventDefault();
                      onOpenPage(pg.id);
                    }}
                  >
                    {pg.title}
                  </a>
                ))}
              </div>
            )}
          </Panel>

          <Panel title="Tables">
            {tables.length === 0 ? (
              <p className="hint">No tables yet.</p>
            ) : (
              <ul className="insp-rows">
                {tables.map((t) => (
                  <li key={t.name}>
                    <span className="ops-mono">{t.name}</span>
                    <span className="insp-meta">
                      {t.rows < 0 ? "unreadable" : `${t.rows.toLocaleString()} ${t.rows === 1 ? "row" : "rows"}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {sites.length > 0 && (
            <Panel title="Sites">
              <ul className="insp-rows">
                {sites.map((site) => (
                  <li key={site.path}>
                    {detail.sitesBase && site.hasIndex ? (
                      <a
                        className="ops-link"
                        href={`${detail.sitesBase}/${encodeURIComponent(site.project)}/${encodeURIComponent(site.name)}/`}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        {site.name}
                      </a>
                    ) : (
                      <span>{site.name}</span>
                    )}
                    <span className="insp-meta">{site.hasIndex ? "live" : "no index.html"}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </aside>
      </div>
    </div>
  );
}
