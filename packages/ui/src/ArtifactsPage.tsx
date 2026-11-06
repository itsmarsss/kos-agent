import { Chips, Count, Empty, NavIcon, PlusIcon, Skeleton, Tag, type ChipOption } from "@kos/kit";
import { WORKSPACE_SCOPE, relativeWords, type ArtifactKind, type HtmlPage } from "@kos/shared";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { api, type ArtifactSummary, type PageSummary, type PageVersion, type Project } from "./api.js";
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

const KIND_WORD: Record<ArtifactKind, string> = { page: "Page", doc: "Doc", deck: "Deck", sheet: "Sheet" };

/** The project filter's "every project": like WORKSPACE_SCOPE, never a slug. */
const ALL_PROJECTS = "@all";

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
  ["project", "By project"],
];

/** What New artifact starts the root chat with, for the owner to finish. */
export const NEW_ARTIFACT_WORDS = "Make a ";

/** How many cards the loading gallery draws in their place. */
const SKELETONS = 6;

function ArtifactCard({ a, owner, theme, onOpen }: { a: ArtifactSummary; owner: Project | undefined; theme: "light" | "dark"; onOpen: () => void }): ReactElement {
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
            {owner && <ProjectMark slug={owner.slug} name={owner.name} colour={owner.colour} />}
            <span>{owner ? owner.name : a.projectSlug ?? "Workspace"}</span>
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
  const projectName = (slug: string): string => bySlug.get(slug)?.name ?? slug;

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
        (project === ALL_PROJECTS || (project === WORKSPACE_SCOPE ? a.projectSlug === null : a.projectSlug === project)) &&
        (!q || haystack(a, a.projectSlug ? bySlug.get(a.projectSlug)?.name ?? a.projectSlug : "workspace").includes(q)),
    );
  }, [list, project, bySlug, query]);
  const shown = useMemo(() => matching.filter((a) => kind === "all" || a.artifactKind === kind), [kind, matching]);
  const kinds = useMemo(
    () => KINDS.map(([value, word]): ChipOption<ArtifactKind | "all"> => [value, <>{word}<Count n={value === "all" ? matching.length : matching.filter((a) => a.artifactKind === value).length} /></>]),
    [matching],
  );

  const owners = useMemo(() => {
    const slugs = [...new Set((list ?? []).flatMap((a) => (a.projectSlug ? [a.projectSlug] : [])))];
    return [
      { value: ALL_PROJECTS, label: "All projects" },
      ...((list ?? []).some((a) => a.projectSlug === null) ? [{ value: WORKSPACE_SCOPE, label: "Workspace" }] : []),
      ...slugs.map((s) => ({ value: s, label: bySlug.get(s)?.name ?? s })).sort((a, b) => a.label.localeCompare(b.label)),
    ];
  }, [list, bySlug]);

  // A section per project, the one touched most recently first, and the workspace's own last.
  const groups = useMemo(() => {
    const by = new Map<string | null, ArtifactSummary[]>();
    for (const a of shown) by.set(a.projectSlug, [...(by.get(a.projectSlug) ?? []), a]);
    return [...by.entries()].sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : 0));
  }, [shown]);

  const filtered = kind !== "all" || project !== ALL_PROJECTS || query.trim() !== "";
  const card = (a: ArtifactSummary): ReactElement => <ArtifactCard a={a} owner={a.projectSlug ? bySlug.get(a.projectSlug) : undefined} theme={theme} onOpen={() => onOpen(a.id)} />;
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
        subtitle="The pages, docs, decks and sheets KOS has made, across projects and the workspace."
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
            {owners.length > 2 && <Select value={project} options={owners} onChange={setProject} label="Project" />}
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
          {groups.map(([slug, items]) => (
            <section key={slug ?? WORKSPACE_SCOPE} className="artifact-group" role="listitem">
              <h2 className="label">
                {slug ? projectName(slug) : "Workspace"}
                <Count n={items.length} />
              </h2>
              <CardGrid items={items} label={slug ? projectName(slug) : "Workspace"}>
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
const ROOT_CHAT = "primary:owner";

/** Where "Edit with KOS" takes the owner after asking: the project's chat, or the root chat the request went to. */
export function chatOf(projectSlug: string | null): Route {
  return projectSlug ? { name: "project", slug: projectSlug } : { name: "chats", id: ROOT_CHAT };
}

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
  onOpenProject,
}: {
  id: string;
  projects: Project[];
  onBack: () => void;
  /** What going back says: where it goes. */
  backLabel?: string;
  /** Go to the chat the request went to: the project's, or KOS at the root. */
  onOpenChat: (projectSlug: string | null) => void;
  /** Go to the project that owns it. */
  onOpenProject?: (projectSlug: string) => void;
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

  const load = (): Promise<void> =>
    api.anyPage(id).then((got) => {
      setPreview(undefined);
      setRecord(got.record);
      setOlder(got.kind !== "html");
      if (got.kind === "html") setPage(got.page);
    });
  const failed = (err: unknown): void => setError(err instanceof Error ? err.message : String(err));

  useEffect(() => {
    setError(undefined);
    load().catch(failed);
  }, [id]);

  const project = record?.projectSlug ? projects.find((p) => p.slug === record.projectSlug) : undefined;
  const owner = record?.projectSlug ? project?.name ?? record.projectSlug : "Workspace";

  const convert = (): void => {
    if (!record?.projectSlug) return;
    void api.message(convertRequest(record), `project:${record.projectSlug}`).catch(() => undefined);
    onOpenChat(record.projectSlug);
  };

  const ask = (): void => {
    if (!record || !words.trim()) return;
    void api.message(editRequest(words, record), record.projectSlug ? `project:${record.projectSlug}` : undefined).catch(() => undefined);
    setAsking(false);
    setWords("");
    onOpenChat(record.projectSlug);
  };

  return (
    <div className="artifact-view">
      <button type="button" className="ops-back artifact-view-back" onClick={onBack}>
        {backLabel}
      </button>
      {record && (
        <header className="artifact-view-head">
          <div className="artifact-view-titles">
            <h1 className="artifact-view-title">{record.title}</h1>
            <span className="artifact-view-meta">
              <Tag>{older ? "Older widget page" : KIND_WORD[record.artifactKind]}</Tag>
              <span className="artifact-view-owner">
                {project && <ProjectMark slug={project.slug} name={project.name} colour={project.colour} />}
                {owner}
              </span>
              <span>Updated {relativeWords(Math.round(record.updatedAt / 1000))}</span>
            </span>
            {record.description && <p className="artifact-view-desc">{record.description}</p>}
          </div>
          <div className="artifact-view-acts">
            <button type="button" className="btn btn--ghost btn--sm" aria-expanded={history} onClick={() => setHistory(true)}>
              History
            </button>
            {record.projectSlug && onOpenProject && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => onOpenProject(record.projectSlug!)}>
                Open in project
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
          <label htmlFor="artifact-edit-words">What should change? It goes to {record.projectSlug ? `${owner}'s chat` : "KOS"}.</label>
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
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setPreview(undefined)}>
              Back to current
            </button>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() =>
                void api
                  .pageRollback(record.id, preview.version.version)
                  .then(load)
                  .catch(failed)
              }
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
            {...(!older
              ? {
                  onPreview: (version: PageVersion) =>
                    void api
                      .pageVersion(record.id, version.version)
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
