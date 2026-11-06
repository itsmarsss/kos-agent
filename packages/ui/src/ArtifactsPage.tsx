import { Chips, Empty, NavIcon, Tag, type ChipOption } from "@kos/kit";
import { relativeWords, type ArtifactKind, type HtmlPage } from "@kos/shared";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { api, type ArtifactSummary, type PageSummary, type Project } from "./api.js";
import { PageHead } from "./PageHead.js";
import { PageHistory } from "./PageHistory.js";
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

/** How many missing or stale captures one visit redraws: each is a few seconds of Chrome. */
const REDRAW_MAX = 8;

const isStale = (a: ArtifactSummary): boolean => !a.capturedAt || a.capturedAt < a.updatedAt;

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

export function ArtifactsPage({ projects, onOpen }: { projects: Project[]; onOpen: (id: string) => void }): ReactElement {
  const theme = useDashboardTheme();
  const [list, setList] = useState<ArtifactSummary[]>();
  const [error, setError] = useState<string>();
  const [kind, setKind] = useState<ArtifactKind | "all">("all");
  const [project, setProject] = useState("all");
  const [query, setQuery] = useState("");
  const projectName = useMemo(() => new Map(projects.map((p) => [p.slug, p.name])), [projects]);
  const nameOf = (a: ArtifactSummary): string => (a.projectSlug ? projectName.get(a.projectSlug) ?? a.projectSlug : "Workspace");

  useEffect(() => {
    let stale = false;
    api
      .artifacts()
      .then((got) => !stale && setList(got.filter((a) => a.kind === "html").sort((a, b) => b.updatedAt - a.updatedAt)))
      .catch((err: unknown) => !stale && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      stale = true;
    };
  }, []);

  // Redraw what has no capture, or an old one, one at a time, newest first.
  const redrawn = useRef(new Set<string>());
  useEffect(() => {
    if (!list) return;
    let stopped = false;
    const todo = list.filter((a) => isStale(a) && !redrawn.current.has(a.id)).slice(0, REDRAW_MAX);
    void (async () => {
      for (const a of todo) {
        if (stopped) return;
        redrawn.current.add(a.id);
        const got = await api.checkArtifact(a.id).catch(() => undefined);
        if (!stopped && got?.capturedAt) setList((l) => l?.map((x) => (x.id === a.id ? { ...x, capturedAt: got.capturedAt } : x)));
      }
    })();
    return () => {
      stopped = true;
    };
  }, [list]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (list ?? []).filter(
      (a) =>
        (kind === "all" || a.artifactKind === kind) &&
        (project === "all" || (project === "workspace" ? a.projectSlug === null : a.projectSlug === project)) &&
        (!q || haystack(a, a.projectSlug ? projectName.get(a.projectSlug) ?? a.projectSlug : "workspace").includes(q)),
    );
  }, [kind, list, project, projectName, query]);

  const owners = useMemo(() => {
    const slugs = [...new Set((list ?? []).flatMap((a) => (a.projectSlug ? [a.projectSlug] : [])))];
    return [
      { value: "all", label: "All projects" },
      ...((list ?? []).some((a) => a.projectSlug === null) ? [{ value: "workspace", label: "Workspace" }] : []),
      ...slugs.map((s) => ({ value: s, label: projectName.get(s) ?? s })).sort((a, b) => a.label.localeCompare(b.label)),
    ];
  }, [list, projectName]);

  return (
    <div className="list-page artifacts">
      <PageHead
        title="Artifacts"
        subtitle="The pages, docs, decks and sheets KOS has made, across projects and the workspace."
        search={
          <input
            className="list-search"
            type="search"
            placeholder="Search titles and descriptions"
            aria-label="Search artifacts"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        }
      />
      <div className="list-filters">
        <Chips options={KINDS} selected={kind} onChoose={setKind} label="Kind" small />
        {owners.length > 2 && <Select value={project} options={owners} onChange={setProject} label="Project" />}
      </div>
      {error && (
        <p className="ops-alert ops-alert--err" role="alert">
          {error}
        </p>
      )}
      {list && list.length === 0 && (
        <Empty title="Nothing made yet">Ask KOS for a doc, a deck, a sheet or a page, and it shows up here.</Empty>
      )}
      {list && list.length > 0 && shown.length === 0 && <Empty inline>No artifact matches these filters.</Empty>}
      {!list && !error && <p className="hint">Loading…</p>}
      {shown.length > 0 && (
        <ul className="artifact-grid" aria-label="Artifacts">
          {shown.map((a) => (
            <li key={a.id}>
              <button type="button" className="artifact-card" onClick={() => onOpen(a.id)}>
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
                  {a.description && <span className="artifact-card-desc">{a.description}</span>}
                  <span className="artifact-card-meta">
                    <Tag>{KIND_WORD[a.artifactKind]}</Tag>
                    <span className="artifact-card-owner">{nameOf(a)}</span>
                    <span className="artifact-card-time">{relativeWords(Math.round(a.updatedAt / 1000))}</span>
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** What "Edit with KOS" sends: the owner's words, then which artifact they are about. */
export function editRequest(words: string, record: PageSummary): string {
  return `${words.trim()}\n\nThis is about @page:${record.id}, the ${KIND_WORD[record.artifactKind].toLowerCase()} "${record.title}". Read it with artifacts.get, change it, check it once with artifacts.check, and save it with artifacts.write.`;
}

/**
 * One artifact, filling the page: its frame, its versions with a way back,
 * a way to ask KOS for a change in the chat that owns it, and presenting
 * for a deck.
 */
export function ArtifactViewer({
  id,
  projects,
  onBack,
  onOpenChat,
}: {
  id: string;
  projects: Project[];
  onBack: () => void;
  /** Go to the chat the request went to: the project's, or KOS at the root. */
  onOpenChat: (projectSlug: string | null) => void;
}): ReactElement {
  const [record, setRecord] = useState<PageSummary>();
  const [page, setPage] = useState<HtmlPage>();
  const [error, setError] = useState<string>();
  const [asking, setAsking] = useState(false);
  const [words, setWords] = useState("");
  const frame = useRef<ArtifactHandle>(null);

  const load = (): Promise<void> =>
    api.anyPage(id).then((got) => {
      setRecord(got.record);
      if (got.kind === "html") setPage(got.page);
      else setError("This is an older widget page; open it from its project.");
    });

  useEffect(() => {
    setError(undefined);
    load().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [id]);

  const owner = record?.projectSlug ? projects.find((p) => p.slug === record.projectSlug)?.name ?? record.projectSlug : "Workspace";

  const ask = (): void => {
    if (!record || !words.trim()) return;
    void api.message(editRequest(words, record), record.projectSlug ? `project:${record.projectSlug}` : undefined).catch(() => undefined);
    setAsking(false);
    setWords("");
    onOpenChat(record.projectSlug);
  };

  return (
    <div className="artifact-view">
      <header className="artifact-view-head">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onBack}>
          ← Artifacts
        </button>
        {record && (
          <div className="artifact-view-titles">
            <h1 className="artifact-view-title">{record.title}</h1>
            <span className="artifact-view-meta">
              <Tag>{KIND_WORD[record.artifactKind]}</Tag>
              <span>{owner}</span>
              <span>{relativeWords(Math.round(record.updatedAt / 1000))}</span>
            </span>
          </div>
        )}
        {record && (
          <div className="artifact-view-acts">
            <PageHistory record={record} onRolledBack={load} />
            {record.artifactKind === "deck" && (
              <button type="button" className="btn btn--sm" onClick={() => frame.current?.present()}>
                Present
              </button>
            )}
            <button type="button" className="btn btn--primary btn--sm" aria-expanded={asking} onClick={() => setAsking((v) => !v)}>
              Edit with KOS
            </button>
          </div>
        )}
      </header>
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
      {record?.description && <p className="artifact-view-desc">{record.description}</p>}
      {error && (
        <p className="ops-alert ops-alert--err" role="alert">
          {error}
        </p>
      )}
      {record && page && <ArtifactPage ref={frame} record={record} page={page} onSaved={setRecord} />}
      {!record && !error && <p className="hint">Loading…</p>}
    </div>
  );
}
