import { useEffect, useMemo, useState, type ReactElement } from "react";
import { m } from "motion/react";
import { card, EmptyState, GroupHead, Pill, stagger, StatusPill, When, type Tone } from "@kos/kit";
import { isState, kindWord, STATE_WORDS } from "@kos/shared";

import { api, type Conversation, type CronJob, type PageSummary, type Project } from "./api.js";
import { NewProjectDialog } from "./NewProjectDialog.js";
import { PageHead } from "./PageHead.js";
import { markLetter, markStyle } from "./ProjectMark.js";
import { hrefFor } from "./routes.js";

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
  const [making, setMaking] = useState(false);
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

  // KOS's own (Maintenance) is not the owner's work: it is neither counted
  // nor among their cards, but kept in a group of its own after them, as
  // the chats rail keeps it at its foot.
  const owned = projects.filter((p) => p.type !== "system");
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q ? projects.filter((p) => [p.name, p.slug, p.type, p.description ?? ""].some((w) => w.toLowerCase().includes(q))) : projects;
    // By name, as every list of projects is: the rail, Files, a Move.
    const sorted = [...matched].sort((a, b) => a.name.localeCompare(b.name));
    const byStatus = new Map<string, Project[]>();
    for (const p of sorted) {
      const group = p.type === "system" ? "system" : p.status;
      byStatus.set(group, [...(byStatus.get(group) ?? []), p]);
    }
    const rank = (group: string): number => (group === "system" ? 100 : ORDER.indexOf(group) + 1 || 99);
    return [...byStatus.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
  }, [projects, query]);

  const cardOf = (p: Project): ReactElement => {
    const pages = pagesByProject.get(p.slug) ?? [];
    const live = pages.filter((pg) => pg.trashedAt === undefined);
    const headline = live.find((pg) => pg.headline);
    const attention = attentionOf(p);
    const holds = [many(agentsOf(p.slug), "agent"), many(p.tableCount ?? 0, "table"), many(live.length, "artifact")].filter(Boolean);
    return (
      <m.div key={p.slug} variants={card} className="card card--opens project-card">
        <div className="project-card-head">
          <span className="hero-mark hero-mark--sm hero-mark--letter" aria-hidden="true" style={markStyle(p.slug, p.colour)}>
            {markLetter(p.name)}
          </span>
          <div className="project-card-titles">
            {/* The card is the project: its name is the link, stretched over the card, so a press anywhere opens it and a modified one opens a tab. */}
            <a className="card-name project-card-link" href={hrefFor({ name: "project", slug: p.slug })}>
              {p.name}
            </a>
            <span className="project-card-sub">{p.module ? `${kindWord(p.type)} · from ${p.module}` : kindWord(p.type)}</span>
          </div>
          {attention ? <Pill tone={attention.tone}>{attention.word}</Pill> : p.status !== "active" && isState(p.status) && <StatusPill state={p.status} />}
        </div>
        {/* Why, in words on the card: a title is out of reach of a keyboard and a finger. */}
        {attention?.why && <p className="project-card-why">{attention.why}</p>}
        {p.description && <p className="project-desc">{p.description}</p>}
        {headline?.headline && (
          // The figure a page offers, so the card answers a question before it is opened.
          <a className="project-headline" href={hrefFor({ name: "page", id: headline.id })}>
            <span className="project-headline-value">{String(headline.headline.value)}</span>
            <span className="project-headline-label">{headline.headline.label}</span>
          </a>
        )}
        <div className="project-card-foot">
          <span className="project-card-holds">{holds.length > 0 ? holds.join(" · ") : "Nothing in it yet"}</span>
          <span className="project-card-time">
            <When at={lastOf(p)} />
          </span>
          <button type="button" className="btn btn--sm btn--ghost project-card-details" onClick={() => onInspect(p, pages)} aria-label={`Details of ${p.name}`}>
            Details
          </button>
        </div>
      </m.div>
    );
  };

  // Status heads only where the owner's own fall into more than one.
  const several = groups.filter(([group]) => group !== "system").length > 1;
  return (
    <div className="projects-page">
      <PageHead
        title="Projects"
        count={owned.length}
        subtitle="Each one is a chat of its own, with its agents, tables, files and artifacts."
        search={{ value: query, onChange: setQuery, noun: "projects" }}
        actions={
          onCreate && (
            <button type="button" className="btn btn--primary" onClick={() => setMaking(true)}>
              New project
            </button>
          )
        }
      />

      {onCreate && <NewProjectDialog open={making} onClose={() => setMaking(false)} onCreate={onCreate} />}

      {owned.length === 0 && <EmptyState title="No projects yet">Ask KOS to build something, or make an empty one with New project, and it shows up here.</EmptyState>}
      {query.trim() && groups.length === 0 && <EmptyState query={{ noun: "projects", onClear: () => setQuery("") }} />}

      {groups.map(([status, items]) => (
        <section key={status} className="projects-group" aria-label={status === "system" ? "KOS's own" : several ? status : "Projects"}>
          {(several || status === "system") && (
            <GroupHead title={status === "system" ? "KOS's own" : isState(status) ? STATE_WORDS[status].word : kindWord(status)} count={items.length} />
          )}
          <m.div className="project-grid" variants={stagger} initial="hidden" animate="show">
            {items.map(cardOf)}
          </m.div>
        </section>
      ))}
    </div>
  );
}
