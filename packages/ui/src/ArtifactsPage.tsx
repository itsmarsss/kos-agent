import { Chips, Count, Empty, Face, NavIcon, PlusIcon, Skeleton, Tag, type ChipOption } from "@kos/kit";
import { WORKSPACE_SCOPE, relativeWords, type ArtifactKind, type HtmlPage } from "@kos/shared";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { api, type AnyPagePayload, type ArtifactSummary, type PageSummary, type PageVersion, type Project } from "./api.js";
import { PageHead } from "./PageHead.js";
import { Drawer } from "./Drawer.js";
import { ProjectMark } from "./ProjectMark.js";
import { VersionList } from "./PageHistory.js";
import type { Route } from "./routes.js";
import { Select } from "./Select.js";
import { ArtifactPage, type ArtifactHandle } from "./widgets/ArtifactPage.js";

/**
 * Everything KOS has made for the owner, in one place: pages, docs, decks and
 * sheets, across every project and the workspace.
 *
 * Each card shows the artifact as it last looked: the capture artifacts.check
 * keeps (desktop width, in the dashboard's theme). Not a live render: a
 * gallery of live frames would start every artifact's runtime and queries at
 * once, to draw stamps. A capture costs nothing to show; one that is missing
 * or older than the artifact is redrawn here, one at a time, in the
 * background, and until then the card shows its kind.
 */

const KINDS: readonly ChipOption<ArtifactKind | "all">[] = [
  ["all", "All"],
  ["page", "Pages"],
  ["doc", "Docs"],
  ["deck", "Decks"],
  ["sheet", "Sheets"],
];

/** An artifact's kind as a word, wherever one is named. */
export const KIND_WORD: Record<ArtifactKind, string> = { page: "Page", doc: "Doc", deck: "Deck", sheet: "Sheet" };

/** The project filter's "every project": like WORKSPACE_SCOPE, never a slug. */
const ALL_PROJECTS = "@all";
/** The owner filter's value for a blob: never a project's slug, which has no colon. */
const BLOB_PREFIX = "blob:";
/** An artifact's owner as the filter names it: a project's slug, a blob, or the workspace. */
const ownerValue = (a: Pick<PageSummary, "projectSlug" | "blob">): string => (a.blob ? `${BLOB_PREFIX}${a.blob}` : a.projectSlug ?? WORKSPACE_SCOPE);

/** How many missing or stale captures one visit redraws: each is a few seconds of Chrome. */
const REDRAW_MAX = 8;

/** An older widget-spec page: listed with the rest, but never drawn by artifacts.check, so never redrawn. */
const isWidgetPage = (a: { kind: string }): boolean => a.kind !== "html";

const isStale = (a: ArtifactSummary): boolean => !isWidgetPage(a) && (!a.capturedAt || a.capturedAt < a.updatedAt);

/** What the viewer says of an older widget page. */
const WIDGET_PAGE_WORDS = "This is an older widget page; open it from its project.";

/** The words the gallery's search looks in. */
const haystack = (a: ArtifactSummary, project: string): string => `${a.title} ${a.description ?? ""} ${project}`.toLowerCase();

/** The dashboard's palette now, followed as the owner changes it: the thumbnails match it. */
function useDashboardTheme(): "light" | "dark" {
  const read = (): "light" | "dark" => (document.documentElement.dataset.theme === "light" ? "light" : "dark");
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const watch = new MutationObserver(() => setTheme(read()));
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => watch.disconnect();
  }, []);
  return theme;
}

/** How the gallery is laid out: one grid, newest first, or a section per project. */
type Grouping = "recent" | "project";
const GROUPINGS: readonly ChipOption<Grouping>[] = [
  ["recent", "Recent"],
  ["project", "By owner"],
];

/** What New artifact starts the root chat with, for the owner to finish. */
export const NEW_ARTIFACT_WORDS = "Make a ";

/** How many cards the loading gallery draws in their place. */
const SKELETONS = 6;

function ArtifactCard({ a, projects, theme, onOpen }: { a: ArtifactSummary; projects: Project[]; theme: "light" | "dark"; onOpen: () => void }): ReactElement {
  return (
    <button type="button" className="artifact-card" onClick={onOpen}>
      <span className="artifact-thumb" data-kind={a.artifactKind}>
        {a.capturedAt ? (
          <img src={`/api/artifacts/${encodeURIComponent(a.id)}/thumb?theme=${theme}&v=${Math.round(a.capturedAt)}`} alt="" loading="lazy" />
        ) : (
          <span className="artifact-thumb-mark">
            <NavIcon name={a.artifactKind} />
          </span>
        )}
      </span>
      <span className="artifact-card-body">
        <span className="artifact-card-title">{a.title}</span>
        <span className="artifact-card-desc">{a.description || "\u00a0"}</span>
        <span className="artifact-card-meta">
          {isWidgetPage(a) ? <Tag title="Made before artifacts; KOS can convert it">Older widget page</Tag> : <Tag>{KIND_WORD[a.artifactKind]}</Tag>}
          <span className="artifact-card-owner">
            <OwnerMark record={a} projects={projects} />
          </span>
          <span className="artifact-card-time">{relativeWords(Math.round(a.updatedAt / 1000))}</span>
        </span>
      </span>
    </button>
  );
}

function CardGrid({ items, label, children }: { items: ArtifactSummary[]; label: string; children: (a: ArtifactSummary) => ReactElement }): ReactElement {
  return (
    <ul className="artifact-grid" aria-label={label}>
      {items.map((a) => (
        <li key={a.id}>{children(a)}</li>
      ))}
    </ul>
  );
}

export function ArtifactsPage({ projects, onOpen, onNew }: { projects: Project[]; onOpen: (id: string) => void; onNew?: (words: string) => void }): ReactElement {
  const theme = useDashboardTheme();
  const [list, setList] = useState<ArtifactSummary[]>();
  const [error, setError] = useState<string>();
  const [kind, setKind] = useState<ArtifactKind | "all">("all");
  const [project, setProject] = useState(ALL_PROJECTS);
  const [query, setQuery] = useState("");
  const [grouping, setGrouping] = useState<Grouping>("recent");
  const bySlug = useMemo(() => new Map(projects.map((p) => [p.slug, p])), [projects]);

  useEffect(() => {
    let stale = false;
    api
      .artifacts()
      .then((got) => !stale && setList([...got].sort((a, b) => b.updatedAt - a.updatedAt)))
      .catch((err: unknown) => !stale && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      stale = true;
    };
  }, []);

  // Redraw what has no capture, or an old one, one at a time, newest first,
  // and no more than REDRAW_MAX in a visit: each redraw updates the list,
  // which runs this again, so the count is kept across runs, not per run.
  const redrawn = useRef(new Set<string>());
  useEffect(() => {
    if (!list) return;
    let stopped = false;
    const todo = list.filter((a) => isStale(a) && !redrawn.current.has(a.id));
    void (async () => {
      for (const a of todo) {
        if (stopped || redrawn.current.size >= REDRAW_MAX) return;
        redrawn.current.add(a.id);
        const got = await api.checkArtifact(a.id).catch(() => undefined);
        if (!stopped && got?.capturedAt) setList((l) => l?.map((x) => (x.id === a.id ? { ...x, capturedAt: got.capturedAt } : x)));
      }
    })();
    return () => {
      stopped = true;
    };
  }, [list]);

  // Every filter but the kind's, so each kind chip can say how many it would show.
  const matching = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (list ?? []).filter(
      (a) =>
        (project === ALL_PROJECTS || ownerValue(a) === project) &&
        (!q || haystack(a, ownerName(a, projects)).includes(q)),
    );
  }, [list, project, projects, query]);
  const shown = useMemo(() => matching.filter((a) => kind === "all" || a.artifactKind === kind), [kind, matching]);
  const kinds = useMemo(
    () => KINDS.map(([value, word]): ChipOption<ArtifactKind | "all"> => [value, <>{word}<Count n={value === "all" ? matching.length : matching.filter((a) => a.artifactKind === value).length} /></>]),
    [matching],
  );

  const owners = useMemo(() => {
    const slugs = [...new Set((list ?? []).flatMap((a) => (a.projectSlug ? [a.projectSlug] : [])))];
    const blobs = [...new Set((list ?? []).flatMap((a) => (a.blob ? [a.blob] : [])))].sort();
    return [
      { value: ALL_PROJECTS, label: "Everyone's" },
      ...((list ?? []).some((a) => a.projectSlug === null && !a.blob) ? [{ value: WORKSPACE_SCOPE, label: "Workspace" }] : []),
      ...slugs
        .map((s) => ({ value: s, label: bySlug.get(s)?.name ?? s, icon: <ProjectMark slug={s} name={bySlug.get(s)?.name ?? s} colour={bySlug.get(s)?.colour} /> }))
        .sort((a, b) => a.label.localeCompare(b.label)),
      ...blobs.map((b) => ({ value: `${BLOB_PREFIX}${b}`, label: b, icon: <Face seed={b} size={14} /> })),
    ];
  }, [list, bySlug]);

  // A section per project, the one touched most recently first, and the workspace's own last.
  const groups = useMemo(() => {
    const by = new Map<string, ArtifactSummary[]>();
    for (const a of shown) by.set(ownerValue(a), [...(by.get(ownerValue(a)) ?? []), a]);
    return [...by.values()].sort(([a], [b]) => (ownerValue(a!) === WORKSPACE_SCOPE ? 1 : ownerValue(b!) === WORKSPACE_SCOPE ? -1 : 0));
  }, [shown]);

  const filtered = kind !== "all" || project !== ALL_PROJECTS || query.trim() !== "";
  const card = (a: ArtifactSummary): ReactElement => <ArtifactCard a={a} projects={projects} theme={theme} onOpen={() => onOpen(a.id)} />;
  const newArtifact = onNew ? (
    <button type="button" className="btn btn--primary btn--sm artifacts-new" onClick={() => onNew(NEW_ARTIFACT_WORDS)}>
      <PlusIcon size={13} title="" />
      New artifact
    </button>
  ) : null;

  return (
    <div className="list-page artifacts">
      <PageHead
        title="Artifacts"
        {...(list ? { count: list.length } : {})}
        subtitle="The pages, docs, decks and sheets KOS has made, across projects, blobs and the workspace."
        search={
          <input
            className="list-search"
            type="search"
            placeholder="Search artifacts"
            aria-label="Search artifacts"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        }
        actions={newArtifact}
      />
      {list && list.length > 0 && (
        <div className="artifacts-bar">
          <Chips options={kinds} selected={kind} onChoose={setKind} label="Kind" small scroll />
          <div className="artifacts-bar-end">
            {owners.length > 2 && <Select value={project} options={owners} onChange={setProject} label="Owner" />}
            <Chips options={GROUPINGS} selected={grouping} onChoose={setGrouping} label="Group" small />
          </div>
        </div>
      )}
      {error && (
        <p className="ops-alert ops-alert--err" role="alert">
          {error}
        </p>
      )}
      {!list && !error && (
        <ul className="artifact-grid" aria-label="Loading artifacts" aria-busy="true">
          {Array.from({ length: SKELETONS }, (_, i) => (
            <li key={i}>
              <span className="artifact-card artifact-card--loading">
                <Skeleton className="artifact-thumb" radius={0} height="auto" />
                <span className="artifact-card-body">
                  <Skeleton width="60%" height={14} />
                  <Skeleton width="85%" height={12} />
                  <Skeleton width="40%" height={12} />
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {list && list.length === 0 && (
        <div className="artifacts-empty">
          <Empty title="Nothing made yet">Ask KOS for a doc, a deck, a sheet or a page, and it shows up here.</Empty>
          {newArtifact}
        </div>
      )}
      {list && list.length > 0 && shown.length === 0 && (
        <div className="artifacts-none">
          <Empty inline>No artifact matches these filters.</Empty>
          {filtered && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                setKind("all");
                setProject(ALL_PROJECTS);
                setQuery("");
              }}
            >
              Clear filters
            </button>
          )}
        </div>
      )}
      {shown.length > 0 && grouping === "recent" && (
        <section className="artifact-group">
          <h2 className="label">Recently updated</h2>
          <CardGrid items={shown} label="Artifacts">
            {card}
          </CardGrid>
        </section>
      )}
      {shown.length > 0 && grouping === "project" && (
        <div className="artifact-groups" role="list" aria-label="Artifacts">
          {groups.map((items) => (
            <section key={ownerValue(items[0]!)} className="artifact-group" role="listitem">
              <h2 className="label">
                {ownerName(items[0]!, projects)}
                <Count n={items.length} />
              </h2>
              <CardGrid items={items} label={ownerName(items[0]!, projects)}>
                {card}
              </CardGrid>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

/** KOS's own chat at the root, where a message with no chat named goes: the profile's owner id is fixed. */
export const ROOT_CHAT = "primary:owner";

/** Who an artifact belongs to: a project, a blob, or the workspace (null). */
export type ArtifactOwner = { project: string } | { blob: string } | null;

export const ownerOf = (r: Pick<PageSummary, "projectSlug" | "blob">): ArtifactOwner => (r.blob ? { blob: r.blob } : r.projectSlug ? { project: r.projectSlug } : null);

/** The chat that answers for an artifact: its project's, its blob's thread, or KOS at the root (undefined). */
export const chatIdOf = (owner: ArtifactOwner): string | undefined => (!owner ? undefined : "project" in owner ? `project:${owner.project}` : `agent:${owner.blob}`);

/** Where "Edit with KOS" takes the owner after asking: the project's page, the blob's, or the root chat the request went to. */
export function chatOf(owner: ArtifactOwner): Route {
  if (!owner) return { name: "chats", id: ROOT_CHAT };
  return "project" in owner ? { name: "project", slug: owner.project } : { name: "blobs", blob: owner.blob };
}

/** An owner's mark and name, for a card, a row or the viewer's head. */
export function OwnerMark({ record, projects }: { record: Pick<PageSummary, "projectSlug" | "blob">; projects: Project[] }): ReactElement {
  if (record.blob) {
    return (
      <>
        <Face seed={record.blob} size={16} />
        <span>{record.blob}</span>
      </>
    );
  }
  const project = record.projectSlug ? projects.find((p) => p.slug === record.projectSlug) : undefined;
  return (
    <>
      {record.projectSlug && <ProjectMark slug={record.projectSlug} name={project?.name ?? record.projectSlug} colour={project?.colour} />}
      <span>{record.projectSlug ? project?.name ?? record.projectSlug : "Workspace"}</span>
    </>
  );
}

/** An owner as a word. */
const ownerName = (r: Pick<PageSummary, "projectSlug" | "blob">, projects: Project[]): string =>
  r.blob ?? (r.projectSlug ? projects.find((p) => p.slug === r.projectSlug)?.name ?? r.projectSlug : "Workspace");

/** What "Edit with KOS" sends: the owner's words, then which artifact they are about. */
export function editRequest(words: string, record: PageSummary): string {
  return `${words.trim()}\n\nThis is about @page:${record.id}, the ${KIND_WORD[record.artifactKind].toLowerCase()} "${record.title}". Read it with artifacts.get, change it, check it once with artifacts.check, and save it with artifacts.write under the same id, leaving project out so it stays where it is.`;
}

/** What "Convert with KOS" sends to the owning chat: rewrite the widget page as an artifact under the same id. */
export function convertRequest(record: PageSummary): string {
  return `Convert the older widget page @page:${record.id} ("${record.title}") into an artifact. Read it with artifacts.get, read artifacts.guide for the kind that fits (usually a page), and write it with artifacts.write as HTML under the same id, leaving project out so it stays in its project and keeps its versions. Keep what it shows and what it lets the owner change. Check it once with artifacts.check.`;
}

/**
 * One artifact, filling the page: a head that says what it is and holds what
 * can be done with it (ask KOS for a change in the chat that owns it, its
 * versions in a drawer with a way back, presenting for a deck, its project),
 * then the artifact itself, drawn as part of the page.
 */
export function ArtifactViewer({
  id,
  projects,
  onBack,
  backLabel = "← Artifacts",
  onOpenChat,
  onOpenOwner,
  initial,
}: {
  id: string;
  projects: Project[];
  /** The artifact already loaded by whoever shows this, so it is not fetched twice. */
  initial?: AnyPagePayload;
  onBack: () => void;
  /** What going back says: where it goes. */
  backLabel?: string;
  /** Go to the chat the request went to: the project's, the blob's, or KOS at the root. */
  onOpenChat: (owner: ArtifactOwner) => void;
  /** Go to whoever owns it: its project's page or its blob's. */
  onOpenOwner?: (owner: NonNullable<ArtifactOwner>) => void;
}): ReactElement {
  const [record, setRecord] = useState<PageSummary>();
  const [page, setPage] = useState<HtmlPage>();
  const [error, setError] = useState<string>();
  const [older, setOlder] = useState(false);
  const [asking, setAsking] = useState(false);
  const [history, setHistory] = useState(false);
  const [words, setWords] = useState("");
  /** An older version shown in place of the current one, to look at before restoring it. */
  const [preview, setPreview] = useState<{ version: PageVersion; page: HtmlPage }>();
  const frame = useRef<ArtifactHandle>(null);

  const show = (got: AnyPagePayload): void => {
    setPreview(undefined);
    setRecord(got.record);
    setOlder(got.kind !== "html");
    if (got.kind === "html") setPage(got.page);
  };
  const load = (): Promise<void> => api.anyPage(id).then(show);
  const failed = (err: unknown): void => setError(err instanceof Error ? err.message : String(err));
  /** Whatever the doc has not saved is saved before the frame goes. */
  const settle = (): Promise<void> => frame.current?.settle() ?? Promise.resolve();
  const restore = (version: number): Promise<void> =>
    settle()
      .then(() => api.pageRollback(id, version, record?.updatedAt))
      .then(load);

  // A new artifact in the same viewer (another one picked beside a chat): the one open finishes its editing first.
  useEffect(() => {
    setError(undefined);
    if (initial?.record.id === id && !record) {
      show(initial);
      return;
    }
    void settle()
      .then(load)
      .catch(failed);
  }, [id]);

  const whose = record ? ownerOf(record) : null;
  const owner = record ? ownerName(record, projects) : "Workspace";

  const convert = (): void => {
    if (!record?.projectSlug) return;
    void api.message(convertRequest(record), `project:${record.projectSlug}`).catch(() => undefined);
    onOpenChat({ project: record.projectSlug });
  };

  const ask = (): void => {
    if (!record || !words.trim()) return;
    void api.message(editRequest(words, record), chatIdOf(whose)).catch(() => undefined);
    setAsking(false);
    setWords("");
    onOpenChat(whose);
  };

  return (
    <div className="artifact-view">
      <button type="button" className="ops-back artifact-view-back" onClick={() => void settle().then(onBack)}>
        {backLabel}
      </button>
      {record && (
        <header className="artifact-view-head">
          <div className="artifact-view-titles">
            <h1 className="artifact-view-title">{record.title}</h1>
            <span className="artifact-view-meta">
              <Tag>{older ? "Older widget page" : KIND_WORD[record.artifactKind]}</Tag>
              <span className="artifact-view-owner">
                <OwnerMark record={record} projects={projects} />
              </span>
              <span>Updated {relativeWords(Math.round(record.updatedAt / 1000))}</span>
            </span>
            {record.description && <p className="artifact-view-desc">{record.description}</p>}
          </div>
          <div className="artifact-view-acts">
            <button type="button" className="btn btn--ghost btn--sm" aria-expanded={history} onClick={() => setHistory(true)}>
              History
            </button>
            {whose && onOpenOwner && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => void settle().then(() => onOpenOwner(whose))}>
                Open {owner}
              </button>
            )}
            {record.artifactKind === "deck" && !older && (
              <button type="button" className="btn btn--sm" onClick={() => frame.current?.present()}>
                Present
              </button>
            )}
            {!older && (
              <button type="button" className="btn btn--primary btn--sm" aria-expanded={asking} onClick={() => setAsking((v) => !v)}>
                Edit with KOS
              </button>
            )}
          </div>
        </header>
      )}
      {asking && record && (
        <form
          className="artifact-ask-edit"
          onSubmit={(e) => {
            e.preventDefault();
            ask();
          }}
        >
          <label htmlFor="artifact-edit-words">What should change? It goes to {whose ? `${owner}'s chat` : "KOS"}.</label>
          <div className="artifact-ask-edit-row">
            <input id="artifact-edit-words" className="kos-input" autoFocus value={words} onChange={(e) => setWords(e.target.value)} placeholder="Add a slide on risks after the timeline" />
            <button type="submit" className="btn btn--primary btn--sm" disabled={!words.trim()}>
              Ask KOS
            </button>
          </div>
        </form>
      )}
      {older && record && (
        <div className="ops-alert artifact-older" role="status">
          <span>{WIDGET_PAGE_WORDS}</span>
          {record.projectSlug && (
            <button type="button" className="btn btn--sm" onClick={convert}>
              Convert with KOS
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="ops-alert ops-alert--err" role="alert">
          {error}
        </p>
      )}
      {preview && record && (
        <div className="ops-alert artifact-preview" role="status">
          <span>
            Looking at version {preview.version.version}, from {relativeWords(Math.round(preview.version.at / 1000))}. Nothing here is saved.
          </span>
          <span className="artifact-preview-acts">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => void load().catch(failed)}>
              Back to current
            </button>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => void restore(preview.version.version).catch(failed)}
            >
              Restore this version
            </button>
          </span>
        </div>
      )}
      {record && preview && <ArtifactPage key={`v${preview.version.version}`} record={record} page={preview.page} locked />}
      {record && page && !preview && <ArtifactPage ref={frame} record={record} page={page} onSaved={setRecord} onReload={() => void load().catch(failed)} />}
      {!record && !error && (
        <div className="artifact-view-loading" aria-busy="true" aria-label="Loading the artifact">
          <Skeleton width="40%" height={26} />
          <Skeleton width="25%" height={14} />
          <Skeleton height="60vh" radius="var(--r-md)" />
        </div>
      )}
      {record && (
        <Drawer open={history} title="History" subtitle={record.title} onClose={() => setHistory(false)}>
          <VersionList
            record={record}
            {...(preview ? { previewing: preview.version.version } : {})}
            onRolledBack={() => load().then(() => setHistory(false))}
            onRestore={(version) =>
              restore(version)
                .then(() => setHistory(false))
                .catch(failed)
            }
            {...(!older
              ? {
                  onPreview: (version: PageVersion) =>
                    void settle()
                      .then(() => api.pageVersion(record.id, version.version))
                      .then((got) => {
                        setPreview({ version, page: got });
                        setHistory(false);
                      })
                      .catch(failed),
                }
              : {})}
          />
        </Drawer>
      )}
    </div>
  );
}
