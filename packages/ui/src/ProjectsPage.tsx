import { useEffect, useMemo, useState, type ReactElement } from "react";
import { m } from "motion/react";
import { card, Count, Empty, Pill, stagger, type Tone } from "@kos/kit";
import { relativeWords } from "@kos/shared";

import { api, type Conversation, type CronJob, type PageSummary, type Project } from "./api.js";
import { FileIcon } from "./FileIcon.js";
import { NewProjectDialog } from "./NewProjectDialog.js";
import { PageHead } from "./PageHead.js";
import { markStyle } from "./ProjectMark.js";
import { hrefFor } from "./routes.js";
import { Select, type SelectOption } from "./Select.js";

/**
 * Projects as cards, one shape each: the mark, the name and its kind, what it
 * is for, the figure a page offers, then one quiet line of what it holds
 * (agents, tables, artifacts) and when it last moved. A card says when it
 * wants the owner (a job failing, a chat waiting on them) and is otherwise
 * quiet: its name, a link over the whole card, opens the project, Details
 * its drawer.
 */

export interface ProjectsPageProps {
  projects: Project[];
  pagesByProject: Map<string, PageSummary[]>;
  /** Every conversation, so a card can count its agents and say when one is working or waiting. */
  conversations: Conversation[];
  /** Every job, so a card can say one of its own is failing. */
  crons: CronJob[];
  /** The drawer, for status and metadata. */
  onInspect: (project: Project, pages: PageSummary[]) => void;
  /** An empty project of the owner's own, with nothing in it until they or KOS put something there. */
  onCreate?: (input: { name: string; type: string }) => Promise<void>;
}

/** Active first: dormant and archived are things you look up, not scan. */
const ORDER = ["active", "born", "dormant", "done", "archived"];

type Sort = "recent" | "name";
const SORTS: SelectOption[] = [
  { value: "recent", label: "Recent" },
  { value: "name", label: "Name" },
];

/** What a card says first, when anything: the one thing that wants the owner. */
interface Attention {
  tone: Tone;
  word: string;
  why?: string;
}

/** A thread doing a piece of a project's work, as the owner counts them: a chat of its own, not archived, not a schedule's. */
export const isProjectAgent = (c: Pick<Conversation, "kind" | "archived">): boolean => c.kind === "chat" && !c.archived;

/** How many of a thing, in words, or nothing when there are none. */
const many = (n: number, one: string): string | null => (n > 0 ? `${n} ${n === 1 ? one : `${one}s`}` : null);

/** Each project's table count, read from its detail once the page opens; absent until it answers. */
function useTableCounts(slugs: string[]): Map<string, number> {
  const [counts, setCounts] = useState(new Map<string, number>());
  const key = slugs.join("\n");
  useEffect(() => {
    let stale = false;
    for (const slug of slugs) {
      void api
        .projectDetail(slug)
        .then((d) => !stale && setCounts((was) => new Map(was).set(slug, d.tables.length)))
        .catch(() => undefined);
    }
    return () => {
      stale = true;
    };
  }, [key]);
  return counts;
}

/** The jobs failing now, by their id, with what went wrong, read once the page opens. */
function useFailingJobs(): Map<number, string> {
  const [failing, setFailing] = useState(new Map<number, string>());
  useEffect(() => {
    let stale = false;
    void api
      .health()
      .then((h) => {
        if (stale) return;
        // A job's health is kept under "cron:<id>".
        const jobs = h.failing.flatMap((f): [number, string][] => (/^cron:\d+$/.test(f.key) ? [[Number(f.key.slice(5)), f.error ?? f.label]] : []));
        setFailing(new Map(jobs));
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, []);
  return failing;
}

export function ProjectsPage({ projects, pagesByProject, conversations, crons, onInspect, onCreate }: ProjectsPageProps): ReactElement {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("recent");
  const [making, setMaking] = useState(false);
  const tables = useTableCounts(useMemo(() => projects.map((p) => p.slug), [projects]));
  const failing = useFailingJobs();

  const threadsOf = (slug: string): Conversation[] => conversations.filter((c) => c.projectSlug === slug && !c.archived);
  const agentsOf = (slug: string): number => threadsOf(slug).filter(isProjectAgent).length;
  /** When anything in it last moved: the project itself, or any of its threads. */
  const lastOf = (p: Project): number => Math.max(p.lastTouchedAt, ...threadsOf(p.slug).map((c) => c.updatedAt));
  const attentionOf = (p: Project): Attention | null => {
    const broken = crons.find((c) => c.projectSlug === p.slug && failing.has(c.id));
    if (broken) return { tone: "danger", word: "Job failing", why: `${broken.name}: ${failing.get(broken.id)}` };
    const threads = threadsOf(p.slug);
    if (threads.some((c) => c.activity === "needs-you")) return { tone: "warn", word: "Needs you" };
    if (threads.some((c) => c.activity === "error")) return { tone: "danger", word: "Chat failed" };
    if (threads.some((c) => c.activity === "working")) return { tone: "accent", word: "Working" };
    return null;
  };

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q ? projects.filter((p) => [p.name, p.slug, p.type, p.description ?? ""].some((w) => w.toLowerCase().includes(q))) : projects;
    // KOS's own (Maintenance) after the owner's, whatever the order.
    const system = (p: Project): number => (p.type === "system" ? 1 : 0);
    const sorted = [...matched].sort((a, b) => system(a) - system(b) || (sort === "name" ? a.name.localeCompare(b.name) : lastOf(b) - lastOf(a)));
    const byStatus = new Map<string, Project[]>();
    for (const p of sorted) byStatus.set(p.status, [...(byStatus.get(p.status) ?? []), p]);
    return [...byStatus.entries()].sort((a, b) => (ORDER.indexOf(a[0]) + 1 || 99) - (ORDER.indexOf(b[0]) + 1 || 99));
  }, [projects, query, sort, conversations]);

  const cardOf = (p: Project): ReactElement => {
    const pages = pagesByProject.get(p.slug) ?? [];
    const live = pages.filter((pg) => pg.trashedAt === undefined);
    const headline = live.find((pg) => pg.headline);
    const attention = attentionOf(p);
    const tableCount = tables.get(p.slug);
    const holds = [many(agentsOf(p.slug), "agent"), tableCount !== undefined ? many(tableCount, "table") : null, many(live.length, "artifact")].filter(Boolean);
    return (
      <m.div key={p.slug} variants={card} className="card card--opens project-card">
        <div className="project-card-head">
          <span className="hero-mark hero-mark--sm" aria-hidden="true" style={markStyle(p.slug, p.colour)}>
            <FileIcon name={p.slug} kind="dir" size={16} />
          </span>
          <div className="project-card-titles">
            {/* The card is the project: its name is the link, stretched over the card, so a press anywhere opens it and a modified one opens a tab. */}
            <a className="card-name project-card-link" href={hrefFor({ name: "project", slug: p.slug })}>
              {p.name}
            </a>
            <span className="project-card-sub">{p.module ? `${p.type} · from ${p.module}` : p.type}</span>
          </div>
          {attention ? <Pill tone={attention.tone}>{attention.word}</Pill> : p.status !== "active" && <Pill tone="muted">{p.status}</Pill>}
        </div>
        {/* Why, in words on the card: a title is out of reach of a keyboard and a finger. */}
        {attention?.why && <p className="project-card-why">{attention.why}</p>}
        {/* Its room is kept when it has none, so a row of cards lines up. */}
        <p className="project-desc">{p.description}</p>
        {headline?.headline && (
          // The figure a page offers, so the card answers a question before it is opened.
          <a className="project-headline" href={hrefFor({ name: "page", id: headline.id })}>
            <span className="project-headline-value">{String(headline.headline.value)}</span>
            <span className="project-headline-label">{headline.headline.label}</span>
          </a>
        )}
        <div className="project-card-foot">
          <span className="project-card-holds">{holds.length > 0 ? holds.join(" · ") : "Nothing in it yet"}</span>
          <span className="project-card-time" title="Last activity">
            {relativeWords(Math.round(lastOf(p) / 1000))}
          </span>
          <button type="button" className="btn btn--sm btn--ghost project-card-details" onClick={() => onInspect(p, pages)} aria-label={`Details of ${p.name}`}>
            Details
          </button>
        </div>
      </m.div>
    );
  };

  const several = groups.length > 1;
  return (
    <div className="projects-page">
      <PageHead
        title="Projects"
        count={projects.length}
        subtitle="Each one is a chat of its own, with its agents, tables, files and artifacts."
        search={<input className="list-search" type="search" value={query} placeholder="Search projects" aria-label="Search projects" onChange={(e) => setQuery(e.target.value)} />}
        actions={
          <>
            {projects.length > 1 && <Select className="artifacts-select" value={sort} options={SORTS} onChange={(v) => setSort(v as Sort)} label="Sort" />}
            {onCreate && (
              <button type="button" className="btn btn--primary" onClick={() => setMaking(true)}>
                New project
              </button>
            )}
          </>
        }
      />

      {onCreate && <NewProjectDialog open={making} onClose={() => setMaking(false)} onCreate={onCreate} />}

      {projects.length === 0 && <Empty title="No projects yet">Ask KOS to build something, or make an empty one with New project, and it shows up here.</Empty>}
      {projects.length > 0 && groups.length === 0 && <Empty inline>No project matches “{query.trim()}”.</Empty>}

      {groups.map(([status, items]) => (
        <section key={status} className="projects-group" aria-label={several ? status : "Projects"}>
          {several && (
            <h2 className="label projects-group-head">
              {status}
              <Count n={items.length} />
            </h2>
          )}
          <m.div className="project-grid" variants={stagger} initial="hidden" animate="show">
            {items.map(cardOf)}
          </m.div>
        </section>
      ))}
    </div>
  );
}
