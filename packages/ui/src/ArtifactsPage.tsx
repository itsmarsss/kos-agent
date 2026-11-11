import { Chips, Count, Empty, Face, NavIcon, PlusIcon, Skeleton, Tag, type ChipOption } from "@kos/kit";
import { WORKSPACE_SCOPE, relativeWords, type ArtifactKind, type HtmlPage } from "@kos/shared";
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactElement, type Ref } from "react";

import { api, type AnyPagePayload, type ArtifactSummary, type PageSummary, type PageVersion, type Project } from "./api.js";
import { PageHead } from "./PageHead.js";
import { Drawer } from "./Drawer.js";
import { ProjectMark } from "./ProjectMark.js";
import { VersionList } from "./PageHistory.js";
import type { Route } from "./routes.js";
import { Select } from "./Select.js";
import { ArtifactHead, ArtifactMenu, type MenuItem } from "./ArtifactHead.js";
import { TrashNotice, useArtifactOps, type ArtifactChange } from "./ArtifactManage.js";
import { hrefFor } from "./routes.js";
import { ArtifactPage, type ArtifactHandle, type DeckView, type EditState } from "./widgets/ArtifactPage.js";

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
/** An artifact's owner as the filter names it: a project's slug, a blob by its id (a removed one apart from a later one of its name), or the workspace. */
const ownerValue = (a: Pick<PageSummary, "projectSlug" | "blob" | "blobId">): string => (a.blob ? `${BLOB_PREFIX}${a.blobId ?? a.blob}` : a.projectSlug ?? WORKSPACE_SCOPE);

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
export function useDashboardTheme(): "light" | "dark" {
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

function ArtifactCard({ a, projects, theme, onOpen, menu }: { a: ArtifactSummary; projects: Project[]; theme: "light" | "dark"; onOpen: () => void; menu: MenuItem[] }): ReactElement {
  return (
    <div className="artifact-card-wrap">
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
            {/* In the trash, when it went there: the view's own head says it is the trash. */}
            <span className="artifact-card-time" {...(a.trashedAt !== undefined ? { title: "When it was moved to the trash" } : {})}>
              {relativeWords(Math.round((a.trashedAt ?? a.updatedAt) / 1000))}
            </span>
          </span>
        </span>
      </button>
      {/* Beside the card's button, not in it: a button holds no other. */}
      <ArtifactMenu className="artifact-card-menu" label={`Actions for ${a.title}`} items={menu} />
    </div>
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

/** The gallery's two views: what is in use, and what the owner put in the trash. */
type View = "all" | "trash";

const newestFirst = (items: ArtifactSummary[]): ArtifactSummary[] => [...items].sort((a, b) => b.updatedAt - a.updatedAt);
const trashedFirst = (items: ArtifactSummary[]): ArtifactSummary[] => [...items].sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0));

export function ArtifactsPage({ projects, onOpen, onNew }: { projects: Project[]; onOpen: (id: string) => void; onNew?: (words: string) => void }): ReactElement {
  const theme = useDashboardTheme();
  const [list, setList] = useState<ArtifactSummary[]>();
  const [trash, setTrash] = useState<ArtifactSummary[]>();
  const [view, setView] = useState<View>("all");
  const [error, setError] = useState<string>();
  /** What was just put in the trash, with a way to take it back. */
  const [trashed, setTrashed] = useState<ArtifactSummary>();
  const [kind, setKind] = useState<ArtifactKind | "all">("all");
  const [project, setProject] = useState(ALL_PROJECTS);
  const [query, setQuery] = useState("");
  const [grouping, setGrouping] = useState<Grouping>("recent");
  const bySlug = useMemo(() => new Map(projects.map((p) => [p.slug, p])), [projects]);

  useEffect(() => {
    let stale = false;
    const failed = (err: unknown): void => void (!stale && setError(err instanceof Error ? err.message : String(err)));
    api
      .artifacts()
      .then((got) => !stale && setList(newestFirst(got)))
      .catch(failed);
    // The trash is a view beside the gallery: one that cannot be read is shown empty rather than as the gallery's error.
    api
      .trashedArtifacts()
      .then((got) => !stale && setTrash(trashedFirst(got)))
      .catch(() => !stale && setTrash([]));
    return () => {
      stale = true;
    };
  }, []);

  // Each change lands where it belongs: a rename or a move in place, a copy at the top, the trash and back between the two lists.
  const changed = (change: ArtifactChange): void => {
    setError(undefined);
    const without = (items: ArtifactSummary[] | undefined, id: string): ArtifactSummary[] => (items ?? []).filter((a) => a.id !== id);
    const known = [...(list ?? []), ...(trash ?? [])].find((a) => a.id === (change.op === "delete" ? change.id : change.record.id));
    if (change.op === "delete") return setTrash((t) => without(t, change.id));
    // A record from a write carries no capture; the one the list had is kept, and redrawn when older than the change.
    const next: ArtifactSummary = { ...change.record, ...(known?.capturedAt ? { capturedAt: known.capturedAt } : {}) };
    if (change.op === "duplicate") return setList((l) => newestFirst([next, ...(l ?? [])]));
    if (change.op === "trash") {
      setList((l) => without(l, next.id));
      setTrash((t) => trashedFirst([next, ...without(t, next.id)]));
      return setTrashed(next);
    }
    if (change.op === "restore") {
      setTrash((t) => without(t, next.id));
      setTrashed(undefined);
      return setList((l) => newestFirst([next, ...without(l, next.id)]));
    }
    setList((l) => newestFirst((l ?? []).map((a) => (a.id === next.id ? next : a))));
  };
  const ops = useArtifactOps({ projects, onChanged: changed, onError: setError });

  // Redraw what has no capture, or an old one, one at a time, newest first,
  // and no more than REDRAW_MAX in a visit: each redraw updates the list,
  // which runs this again, so the count is kept across runs, not per run.
  // What is in the trash is left as it was drawn.
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

  const inTrash = view === "trash";
  const source = inTrash ? trash : list;
  // Every filter but the kind's, so each kind chip can say how many it would show.
  const matching = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (source ?? []).filter(
      (a) =>
        (project === ALL_PROJECTS || ownerValue(a) === project) &&
        (!q || haystack(a, ownerName(a, projects)).includes(q)),
    );
  }, [source, project, projects, query]);
  const shown = useMemo(() => matching.filter((a) => kind === "all" || a.artifactKind === kind), [kind, matching]);
  const kinds = useMemo(
    () => KINDS.map(([value, word]): ChipOption<ArtifactKind | "all"> => [value, <>{word}<Count n={value === "all" ? matching.length : matching.filter((a) => a.artifactKind === value).length} /></>]),
    [matching],
  );

  const owners = useMemo(() => {
    const slugs = [...new Set((source ?? []).flatMap((a) => (a.projectSlug ? [a.projectSlug] : [])))];
    const blobs = [...new Map((source ?? []).flatMap((a) => (a.blob ? [[ownerValue(a), a] as const] : []))).values()].sort((a, b) => ownerName(a, projects).localeCompare(ownerName(b, projects)));
    return [
      { value: ALL_PROJECTS, label: "Everyone's" },
      ...((source ?? []).some((a) => a.projectSlug === null && !a.blob) ? [{ value: WORKSPACE_SCOPE, label: "Workspace" }] : []),
      ...slugs
        .map((s) => ({ value: s, label: bySlug.get(s)?.name ?? s, icon: <ProjectMark slug={s} name={bySlug.get(s)?.name ?? s} colour={bySlug.get(s)?.colour} /> }))
        .sort((a, b) => a.label.localeCompare(b.label)),
      ...blobs.map((b) => ({ value: ownerValue(b), label: ownerName(b, projects), icon: <Face seed={b.blob!} size={14} /> })),
    ];
  }, [source, bySlug, projects]);

  // A section per owner, the one touched most recently first, and the workspace's own last.
  const groups = useMemo(() => {
    const by = new Map<string, ArtifactSummary[]>();
    for (const a of shown) by.set(ownerValue(a), [...(by.get(ownerValue(a)) ?? []), a]);
    const latest = (items: ArtifactSummary[]): number => Math.max(...items.map((a) => a.updatedAt));
    const last = (items: ArtifactSummary[]): number => (ownerValue(items[0]!) === WORKSPACE_SCOPE ? 1 : 0);
    return [...by.values()].sort((a, b) => last(a) - last(b) || latest(b) - latest(a));
  }, [shown]);

  const filtered = kind !== "all" || project !== ALL_PROJECTS || query.trim() !== "";
  const card = (a: ArtifactSummary): ReactElement => <ArtifactCard a={a} projects={projects} theme={theme} onOpen={() => onOpen(a.id)} menu={ops.items(a)} />;
  const show = (next: View): void => {
    setView(next);
    setProject(ALL_PROJECTS);
    setTrashed(undefined);
  };
  const newArtifact = onNew ? (
    <button type="button" className="btn btn--primary btn--sm artifacts-new" onClick={() => onNew(NEW_ARTIFACT_WORDS)}>
      <PlusIcon size={13} title="" />
      New artifact
    </button>
  ) : null;
  const actions = inTrash ? (
    <button type="button" className="btn btn--sm" onClick={() => show("all")}>
      Back to artifacts
    </button>
  ) : (
    <>
      <button type="button" className="btn btn--ghost btn--sm artifacts-trash" onClick={() => show("trash")}>
        Trash
        {trash && trash.length > 0 && <Count n={trash.length} />}
      </button>
      {newArtifact}
    </>
  );

  return (
    <div className="list-page artifacts">
      <PageHead
        title={inTrash ? "Trash" : "Artifacts"}
        {...(source ? { count: source.length } : {})}
        subtitle={
          inTrash
            ? "Kept as it was until you restore it or delete it for good. Nothing is deleted on its own."
            : "The pages, docs, decks and sheets KOS has made, across projects, blobs and the workspace."
        }
        search={
          <input
            className="list-search"
            type="search"
            placeholder={inTrash ? "Search the trash" : "Search artifacts"}
            aria-label={inTrash ? "Search the trash" : "Search artifacts"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        }
        actions={actions}
      />
      {trashed && !inTrash && (
        <div className="ops-alert artifact-preview" role="status">
          <span>“{trashed.title}” is in the trash.</span>
          <span className="artifact-preview-acts">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => show("trash")}>
              Open the trash
            </button>
            <button type="button" className="btn btn--sm" disabled={ops.busy} onClick={() => ops.restore(trashed)}>
              Undo
            </button>
          </span>
        </div>
      )}
      {source && source.length > 0 && (
        <div className="artifacts-bar">
          <Chips options={kinds} selected={kind} onChoose={setKind} label="Kind" small scroll />
          <div className="artifacts-bar-end">
            {owners.length > 2 && <Select value={project} options={owners} onChange={setProject} label="Owner" />}
            {!inTrash && <Chips options={GROUPINGS} selected={grouping} onChoose={setGrouping} label="Group" small />}
          </div>
        </div>
      )}
      {error && (
        <p className="ops-alert ops-alert--err" role="alert">
          {error}
        </p>
      )}
      {!source && !error && (
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
      {source && source.length === 0 &&
        (inTrash ? (
          <div className="artifacts-empty">
            <Empty title="The trash is empty">What you move to the trash waits here until you restore it or delete it for good.</Empty>
          </div>
        ) : (
          <div className="artifacts-empty">
            <Empty title="Nothing made yet">Ask KOS for a doc, a deck, a sheet or a page, and it shows up here.</Empty>
            {newArtifact}
          </div>
        ))}
      {source && source.length > 0 && shown.length === 0 && (
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
      {shown.length > 0 && (inTrash || grouping === "recent") && (
        <section className="artifact-group">
          <h2 className="label">{inTrash ? "Recently trashed" : "Recently updated"}</h2>
          <CardGrid items={shown} label={inTrash ? "Trash" : "Artifacts"}>
            {card}
          </CardGrid>
        </section>
      )}
      {shown.length > 0 && !inTrash && grouping === "project" && (
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
      {ops.dialogs}
    </div>
  );
}

/** KOS's own chat at the root, where a message with no chat named goes: the owner's Main, by the owner id this KOS is set up with. */
let rootChat: Promise<string> | undefined;
export function rootChatId(): Promise<string> {
  rootChat ??= api.settings().then((s) => `primary:${s.profile.ownerId}`);
  rootChat.catch(() => (rootChat = undefined));
  return rootChat;
}

/** Who an artifact belongs to: a project, a blob, or the workspace (null). */
export type ArtifactOwner = { project: string } | { blob: string } | null;

export const ownerOf = (r: Pick<PageSummary, "projectSlug" | "blob">): ArtifactOwner => (r.blob ? { blob: r.blob } : r.projectSlug ? { project: r.projectSlug } : null);

/** The chat that answers for an artifact: its project's, its blob's thread, or KOS at the root (undefined). */
export const chatIdOf = (owner: ArtifactOwner): string | undefined => (!owner ? undefined : "project" in owner ? `project:${owner.project}` : `agent:${owner.blob}`);

/**
 * Where "Edit with KOS" takes the owner after asking: the project's page, the
 * blob's, or the root chat the request went to; the chat list when the root
 * chat cannot be named (the settings did not load), rather than nowhere.
 */
export async function chatOf(owner: ArtifactOwner): Promise<Route> {
  if (!owner) return rootChatId().then((id): Route => ({ name: "chats", id }), (): Route => ({ name: "chats" }));
  return "project" in owner ? { name: "project", slug: owner.project } : { name: "blobs", blob: owner.blob };
}

/** An owner's mark and name, for a card, a row or the viewer's head. */
export function OwnerMark({ record, projects }: { record: Pick<PageSummary, "projectSlug" | "blob" | "blobRemoved">; projects: Project[] }): ReactElement {
  if (record.blob) {
    return (
      <>
        <Face seed={record.blob} size={16} />
        <span>{ownerName(record, projects)}</span>
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
const ownerName = (r: Pick<PageSummary, "projectSlug" | "blob" | "blobRemoved">, projects: Project[]): string =>
  r.blob ? (r.blobRemoved ? `Removed blob: ${r.blob}` : r.blob) : r.projectSlug ? projects.find((p) => p.slug === r.projectSlug)?.name ?? r.projectSlug : "Workspace";

/** What "Edit with KOS" sends: the owner's words, then which artifact they are about. */
export function editRequest(words: string, record: PageSummary): string {
  return `${words.trim()}\n\nThis is about @page:${record.id}, the ${KIND_WORD[record.artifactKind].toLowerCase()} "${record.title}". Read it with artifacts.get and change only what is asked with artifacts.patch, which checks it as it saves. Only for a redesign, write it whole with artifacts.write under the same id, leaving project out so it stays where it is, and check it once with artifacts.check.`;
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
/** What whoever shows the viewer can ask of it: finish the doc's editing before it goes. */
export interface ViewerHandle {
  settle(): Promise<void>;
}

/** Each viewer open now, so a move elsewhere in the dashboard finishes their editing first. */
const openViewers = new Set<ViewerHandle>();

/** Finish the editing of every open viewer: what a route change awaits, each capped as settle is. */
export function settleOpenViewers(): Promise<void> {
  return Promise.all([...openViewers].map((v) => v.settle())).then(() => undefined);
}

export function ArtifactViewer({
  id,
  projects,
  onBack,
  backTo = "Artifacts",
  onOpenChat,
  onOpenOwner,
  initial,
  ref,
}: {
  id: string;
  projects: Project[];
  /** The artifact already loaded by whoever shows this, so it is not fetched twice. */
  initial?: AnyPagePayload;
  onBack: () => void;
  /** Where going back goes, as a place: "Artifacts", "Home", "the chat". */
  backTo?: string;
  /** Go to the chat the request went to: the project's, the blob's, or KOS at the root. */
  onOpenChat: (owner: ArtifactOwner) => void;
  /** Go to whoever owns it: its project's page or its blob's. */
  onOpenOwner?: (owner: NonNullable<ArtifactOwner>) => void;
  ref?: Ref<ViewerHandle>;
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
  /** The copy just made of it, to go to. */
  const [copy, setCopy] = useState<PageSummary>();
  const frame = useRef<ArtifactHandle>(null);
  const head = useRef<HTMLElement>(null);
  // The frame's own controls, drawn in the head: a doc's editing, a deck's place.
  const [edit, setEdit] = useState<EditState>();
  const [deck, setDeck] = useState<DeckView>();
  // The newest version as saved, read when a restore is sent: the doc's own save just before it is the version it is made on.
  const latest = useRef<PageSummary | undefined>(undefined);
  const saved = (r: PageSummary): void => {
    latest.current = r;
    setRecord(r);
  };

  const show = (got: AnyPagePayload): void => {
    setPreview(undefined);
    saved(got.record);
    setOlder(got.kind !== "html");
    if (got.kind === "html") setPage(got.page);
  };
  const load = (): Promise<void> => api.anyPage(id).then(show);
  const failed = (err: unknown): void => setError(err instanceof Error ? err.message : String(err));
  /** Whatever the doc has not saved is saved before the frame goes. */
  const settle = (): Promise<void> => frame.current?.settle() ?? Promise.resolve();
  const restore = (version: number): Promise<void> =>
    settle()
      .then(() => api.pageRollback(id, version, latest.current?.updatedAt))
      .then(load);
  useImperativeHandle(ref, () => ({ settle }), []);
  // Known while open, so leaving for another route finishes its editing first.
  useEffect(() => {
    const me: ViewerHandle = { settle: () => frame.current?.settle() ?? Promise.resolve() };
    openViewers.add(me);
    return () => void openViewers.delete(me);
  }, []);

  // A new artifact in the same viewer (another one picked beside a chat): the one open finishes its editing first.
  useEffect(() => {
    setError(undefined);
    setCopy(undefined);
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
  const trashed = record?.trashedAt !== undefined;

  const changed = (change: ArtifactChange): void => {
    setError(undefined);
    if (change.op === "delete") return onBack();
    if (change.op === "duplicate") return setCopy(change.record);
    // In the trash the frame is only looked at: its editing goes with it.
    if (change.op === "trash") setEdit(undefined);
    saved(change.record);
  };
  const ops = useArtifactOps({ projects, onChanged: changed, onError: setError });
  // Whatever the doc has not saved is saved first, so a rename or a move is made on the newest version.
  const manage = record ? ops.items(record).map((item) => ({ ...item, act: () => void settle().then(item.act) })) : [];

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
      {record ? (
        <ArtifactHead
          ref={head}
          record={record}
          owner={<OwnerMark record={record} projects={projects} />}
          ownerName={owner}
          kind={older ? "Older widget page" : KIND_WORD[record.artifactKind]}
          backTo={backTo}
          onBack={() => void settle().then(onBack)}
          {...(whose && onOpenOwner && !record.blobRemoved ? { onOpenOwner: () => void settle().then(() => onOpenOwner(whose)) } : {})}
          history={history}
          onHistory={() => setHistory(true)}
          {...(!record.blobRemoved && !older && !trashed ? { onAsk: () => setAsking((v) => !v) } : {})}
          asking={asking}
          manage={manage}
          {...(record.artifactKind === "deck" && !older ? { onPresent: () => frame.current?.present() } : {})}
          {...(edit ? { edit } : {})}
          onEdit={(action) => frame.current?.edit(action)}
          {...(deck ? { deck } : {})}
          onDeck={(action) => frame.current?.deck(action)}
        />
      ) : (
        <div className="artifact-view-head" aria-hidden="true">
          <Skeleton width={26} height={26} radius="50%" />
          <Skeleton width="min(24rem, 50%)" height={16} />
        </div>
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
      {record && trashed && <TrashNotice record={record} ops={ops} />}
      {copy && (
        <div className="ops-alert artifact-preview" role="status">
          <span>Made a copy: “{copy.title}”.</span>
          <span className="artifact-preview-acts">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setCopy(undefined)}>
              Dismiss
            </button>
            <a className="btn btn--sm" href={hrefFor({ name: "artifacts", id: copy.id })} onClick={() => setCopy(undefined)}>
              Open the copy
            </a>
          </span>
        </div>
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
      {record && preview && <ArtifactPage key={`v${preview.version.version}`} ref={frame} record={record} page={preview.page} locked onDeck={setDeck} cover={head} />}
      {record && page && !preview && trashed && <ArtifactPage key="trashed" ref={frame} record={record} page={page} locked onDeck={setDeck} cover={head} />}
      {record && page && !preview && !trashed && (
        <ArtifactPage ref={frame} record={record} page={page} onSaved={saved} onReload={() => void load().catch(failed)} onEdit={setEdit} onDeck={setDeck} cover={head} />
      )}
      {!record && !error && (
        <div className="artifact-view-loading" aria-busy="true" aria-label="Loading the artifact">
          <Skeleton height="60vh" radius="var(--r-md)" />
        </div>
      )}
      {ops.dialogs}
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
