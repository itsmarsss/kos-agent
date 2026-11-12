import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";

import { Chips, Empty, Pill, Switch, Tag } from "@kos/kit";

import { api, type CallerInfo, type CronJob, type FactRow, type ReviewClaim, type ReviewItem, type Conversation } from "./api.js";
import { KnowledgePage } from "./KnowledgePage.js";
import { useEdgeFade } from "./edgefade.js";
import { PageHead } from "./PageHead.js";

/**
 * Memory, in one place.
 *
 * Claims, the decisions the dream job left, the pages it wrote, the log it
 * all comes from, the three jobs that maintain it, and the callers that
 * share it. These were spread over the Knowledge page and four Settings
 * tabs, which is how a feature gets built and never found.
 */

type Tab = "claims" | "decisions" | "pages" | "log" | "jobs" | "callers";

const TABS: { id: Tab; label: string; blurb: string }[] = [
  { id: "claims", label: "Claims", blurb: "What KOS believes, shared by every chat: true everywhere or in one place, each with where it came from." },
  { id: "decisions", label: "Decisions", blurb: "What the tidy job could not settle on its own, and what was settled." },
  { id: "pages", label: "Pages", blurb: "Memory in prose, written from the claims and yours to edit." },
  { id: "log", label: "Log", blurb: "Everything said, searched by words and by meaning." },
  { id: "jobs", label: "Jobs", blurb: "The three jobs that read, tidy and condense what is said." },
  { id: "callers", label: "Callers", blurb: "Other programs that share memory, and what each may see." },
];

export function MemoryPage({
  facts,
  tags,
  conversations = [],
  projectNames,
  onChanged,
}: {
  facts: FactRow[];
  tags: string[];
  /** Projects by slug, so a project's claims are headed by its name. */
  projectNames?: ReadonlyMap<string, string>;
  /** So a log row can name the chat it came from rather than show its id. */
  conversations?: Conversation[];
  onChanged: () => void;
}): ReactElement {
  const titles = useMemo(() => new Map(conversations.map((c) => [c.id, c.title])), [conversations]);
  const [tab, setTab] = useState<Tab>(() => {
    const m = /[?&]tab=([a-z]+)/.exec(window.location.hash);
    return (TABS.find((t) => t.id === m?.[1])?.id ?? "claims");
  });
  const tabsRef = useEdgeFade<HTMLDivElement>();
  /** The new-claim form, opened from the page head. */
  const [adding, setAdding] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  useEffect(() => {
    void api.memoryReview().then((r) => setPendingCount(r.pending.length)).catch(() => undefined);
  }, [tab]);
  return (
    <div className="mem">
      <PageHead
        title="Memory"
        subtitle={TABS.find((t) => t.id === tab)!.blurb}
        {...(tab === "claims"
          ? {
              actions: (
                <button type="button" className="btn btn--primary" aria-expanded={adding} onClick={() => setAdding((v) => !v)}>
                  {adding ? "Cancel" : "New claim"}
                </button>
              ),
            }
          : {})}
      />
      <div className="mem-tabs" role="tablist" aria-label="Memory" ref={tabsRef} onKeyDown={(e) => {
        // The arrows move between tabs, Home and End to the ends; Tab goes on to what the tab shows.
        const at = TABS.findIndex((t) => t.id === tab);
        const to = e.key === "ArrowRight" ? at + 1 : e.key === "ArrowLeft" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : null;
        if (to === null) return;
        e.preventDefault();
        const next = TABS[(to + TABS.length) % TABS.length]!;
        setTab(next.id);
        e.currentTarget.querySelector<HTMLElement>(`#mem-tab-${next.id}`)?.focus();
      }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            id={`mem-tab-${t.id}`}
            type="button"
            role="tab"
            className="mem-tab"
            aria-selected={t.id === tab}
            aria-controls="mem-panel"
            tabIndex={t.id === tab ? 0 : -1}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.id === "decisions" && pendingCount > 0 && <Pill tone="warn">{pendingCount}</Pill>}
          </button>
        ))}
      </div>
      <div id="mem-panel" role="tabpanel" aria-labelledby={`mem-tab-${tab}`} className="mem-panel">
      {tab === "claims" && <KnowledgePage facts={facts} tags={tags} adding={adding} onAdding={setAdding} {...(projectNames ? { projectNames } : {})} onChanged={onChanged} />}
      {tab === "decisions" && <DecisionsTab onChanged={onChanged} />}
      {tab === "pages" && <PagesTab />}
      {tab === "log" && <LogTab titles={titles} />}
      {tab === "jobs" && <JobsTab />}
      {tab === "callers" && <CallersTab />}
      </div>
    </div>
  );
}

function Group({ title, blurb, children }: { title: string; blurb?: string; children: React.ReactNode }): ReactElement {
  return (
    <section className="mem-group">
      <div className="mem-group-head">
        <h2>{title}</h2>
        {blurb && <p className="hint">{blurb}</p>}
      </div>
      {children}
    </section>
  );
}

function when(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** How long ago, in a word or two. */
function ago(ts: number): string {
  const mins = Math.max(1, Math.round((Date.now() - ts) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d ago` : new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** What the question is, in the owner's terms rather than memory's. */
const HEADLINE: Record<ReviewItem["kind"], string> = {
  contradiction: "These claims disagree",
  promotion: "Is this true everywhere, not just in the project?",
  other: "KOS could not settle this on its own",
};

type ReviewAction = "keep" | "both" | "promote" | "dismiss";

/** What KOS said it would do, in the owner's words and as the press that does it. */
function leanOf(item: ReviewItem): { words: string; action: ReviewAction; key?: string } | null {
  const lean = item.lean?.trim();
  if (!lean) return null;
  const keep = /^keep\s+(\S+)$/i.exec(lean);
  if (keep && item.keys.includes(keep[1]!)) {
    const scope = keep[1]!.slice(0, keep[1]!.lastIndexOf("/"));
    return { words: `keep the ${scope === "global" ? "global" : scope.replace(/^project:/, "")} one`, action: "keep", key: keep[1]! };
  }
  const plain = lean.toLowerCase();
  if (plain === "both") return { words: "leave them both", action: "both" };
  if (plain === "promote") return { words: "make it global", action: "promote" };
  if (plain === "dismiss") return { words: "keep it to the project", action: "dismiss" };
  return null;
}

/** How a claim is leaned on, for the hover: it was a line of its own and made every card a read. */
function metaOf(c: ReviewClaim): string {
  return [
    c.kind,
    c.trust && c.trust !== "owner" ? `from ${c.trust === "agent" ? "KOS" : c.trust}` : null,
    c.useCount ? `used ${c.useCount}×${c.lastUsedAt ? `, last ${ago(c.lastUsedAt)}` : ""}` : "never used",
    c.createdAt ? `written ${ago(c.createdAt)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * One open question from the dream job, with the choices that settle it.
 *
 * Only what KOS was not sure enough to settle itself gets here, so the
 * card leads with what it leans to and a press that does that; the claims
 * follow as a row each, value first, with Keep on the row it keeps.
 */
/** A long value shown short, with the rest a press away: a claim written as a report should not be the owner's whole screen. */
function Clamp({ text, chars = 280 }: { text: string; chars?: number }): ReactElement {
  const [all, setAll] = useState(false);
  if (text.length <= chars) return <>{text}</>;
  return (
    <>
      {all ? text : `${text.slice(0, chars).trimEnd()}…`}{" "}
      <button type="button" className="mem-more" onClick={() => setAll((v) => !v)}>
        {all ? "less" : "more"}
      </button>
    </>
  );
}

export function MemoryDecision({ item, onResolved }: { item: ReviewItem; onResolved: () => void }): ReactElement {
  const [busy, setBusy] = useState(false);
  const decide = (action: ReviewAction, key?: string): void => {
    setBusy(true);
    void api
      .resolveMemoryReview(item.id, action, key)
      .then(onResolved, onResolved)
      .finally(() => setBusy(false));
  };
  // Older items, or a payload without the lookup, still show their keys.
  const claims: ReviewClaim[] =
    item.claims ??
    item.keys.map((qualified): ReviewClaim => {
      const slash = qualified.lastIndexOf("/");
      return slash > 0 ? { qualified, scope: qualified.slice(0, slash), key: qualified.slice(slash + 1) } : { qualified, scope: "", key: qualified };
    });
  const lean = leanOf(item);
  return (
    <div className="mem-decision">
      <div className="mem-decision-head">
        <Tag>{item.kind}</Tag>
        <strong>{HEADLINE[item.kind]}</strong>
      </div>
      {lean ? (
        <div className="mem-lean">
          <span>
            KOS leans <strong>{lean.words}</strong>
            {typeof item.sure === "number" ? `, ${Math.round(item.sure * 100)}% sure` : ""}
            {item.note ? (
              <>
                : <Clamp text={item.note} chars={220} />
              </>
            ) : (
              "."
            )}
          </span>
        </div>
      ) : (
        <p className="mem-decision-note">{item.note}</p>
      )}
      <ul className="mem-claims">
        {claims.map((c) => (
          <li key={c.qualified} className={`mem-claim ${c.value === undefined ? "is-gone" : ""}`} title={c.value === undefined ? undefined : metaOf(c)}>
            <div className="mem-claim-main">
              <div className="mem-claim-key">
                {c.scope && <span className="mem-scope">{c.scope}</span>}
                <code>{c.key}</code>
              </div>
              <div className="mem-claim-value">{c.value === undefined ? <em>No longer in memory.</em> : c.value ? <Clamp text={c.value} /> : <em>Empty.</em>}</div>
            </div>
            {item.kind !== "promotion" && c.value !== undefined && (
              <button
                type="button"
                className="btn btn--sm"
                disabled={busy}
                title={`Keep ${c.key}; the other${claims.length > 2 ? "s are" : " is"} archived`}
                onClick={() => decide("keep", c.qualified)}
              >
                Keep this
              </button>
            )}
          </li>
        ))}
      </ul>
      {/* One row of choices: what KOS leans to first, then the others it did not. */}
      <div className="mem-actions mem-decision-acts">
        {lean && (
          <button type="button" className="btn btn--sm btn--primary" disabled={busy} title="What KOS leans to" onClick={() => decide(lean.action, lean.key)}>
            {lean.words[0]!.toUpperCase() + lean.words.slice(1)}
          </button>
        )}
        {item.kind === "promotion" ? (
          <>
            {lean?.action !== "promote" && (
              <button type="button" className={`btn btn--sm ${lean ? "" : "btn--primary"}`} disabled={busy} onClick={() => decide("promote")}>
                Yes, make it global
              </button>
            )}
            {lean?.action !== "dismiss" && (
              <button type="button" className="btn btn--sm" disabled={busy} onClick={() => decide("dismiss")}>
                No, keep it to the project
              </button>
            )}
          </>
        ) : (
          lean?.action !== "both" && (
            <button type="button" className="btn btn--sm" disabled={busy} title="Leave every claim as it is" onClick={() => decide("both")}>
              {claims.length > 2 ? "All are right, leave them" : "Both are right, leave them"}
            </button>
          )
        )}
      </div>
    </div>
  );
}

/** Settled questions shown before "Show all". */
const SETTLED_FIRST = 5;

function DecisionsTab({ onChanged }: { onChanged: () => void }): ReactElement {
  const [pending, setPending] = useState<ReviewItem[]>([]);
  const [recent, setRecent] = useState<ReviewItem[]>([]);
  const [allSettled, setAllSettled] = useState(false);
  const load = useCallback(() => {
    void api.memoryReview().then((r) => { setPending(r.pending); setRecent(r.recent.filter((i) => i.resolvedAt !== null)); }).catch(() => undefined);
  }, []);
  useEffect(load, [load]);
  return (
    <>
      <Group title="Needs a decision" blurb="Only what KOS was not sure enough to settle itself. Keeping one side archives the other; promoting writes the claim global. Either is on the record as yours.">
        {pending.length === 0 && <Empty inline>Nothing waiting. The tidy job settles what it is sure of and leaves here only a contradiction or a promotion it was not; how sure it has to be is in Settings, Behaviour.</Empty>}
        {pending.map((item) => (
          <MemoryDecision key={item.id} item={item} onResolved={() => { load(); onChanged(); }} />
        ))}
      </Group>
      {recent.length > 0 && (
        <Group title="Settled">
          <ul className="mem-settled">
            {(allSettled ? recent : recent.slice(0, SETTLED_FIRST)).map((item) => (
              <li key={item.id} className="mem-settled-row" title={item.keys.join(" vs ")}>
                <Tag>{item.kind}</Tag>
                <span className="mem-settled-keys">
                  {item.keys.map((k, i) => {
                    const slash = k.lastIndexOf("/");
                    const scope = slash > 0 ? k.slice(0, slash).replace(/^project:/, "") : "";
                    return (
                      <span key={k} className="mem-settled-key">
                        {i > 0 && <span className="mem-settled-vs">vs</span>}
                        {scope && <span className="mem-scope">{scope}</span>}
                        {k.slice(slash + 1)}
                      </span>
                    );
                  })}
                </span>
                <span className="mem-settled-how">{item.resolution}</span>
                {item.resolvedAt ? <time className="mem-settled-when">{when(item.resolvedAt)}</time> : null}
              </li>
            ))}
          </ul>
          {recent.length > SETTLED_FIRST && (
            <button type="button" className="btn btn--sm btn--ghost mem-settled-more" onClick={() => setAllSettled((v) => !v)}>
              {allSettled ? "Show fewer" : `Show all ${recent.length}`}
            </button>
          )}
        </Group>
      )}
    </>
  );
}

function PagesTab(): ReactElement {
  const [pages, setPages] = useState<{ name: string; path: string; updatedAt: number }[]>([]);
  const [edited, setEdited] = useState<string[]>([]);
  const [open, setOpen] = useState<{ name: string; markdown: string } | null>(null);
  const load = useCallback(() => {
    void api.memoryReview().then((r) => { setPages(r.pages); setEdited(r.edited ?? []); }).catch(() => undefined);
  }, []);
  useEffect(load, [load]);
  return (
    <Group title="Pages" blurb={'One for you everywhere, one per project, written by the dream job from current claims. Edit a line in the form "- key: value" and it reads back as your word.'}>
      {pages.length === 0 && <Empty inline>No pages yet. The dream job writes them; Run now on the Jobs tab if you do not want to wait for 4am.</Empty>}
      {edited.length > 0 && (
        <p className="hint">
          Edited since memory wrote them: {edited.join(", ")}.{" "}
          <button type="button" className="btn btn--sm" onClick={() => void api.importMemoryPages().then(load, load)}>Read edits into memory</button>
        </p>
      )}
      <Chips
        label="Memory pages"
        options={pages.map((p) => [p.name, `${p.name}${edited.includes(p.name) ? " (edited)" : ""}`] as const)}
        selected={open?.name ?? null}
        onChoose={(name) => void api.memoryPage(name).then(setOpen).catch(() => undefined)}
      />
      {open && (
        <div className="mem-page">
          <div className="hint ops-mono">memory/{open.name}.md</div>
          <pre className="know-page">{open.markdown}</pre>
        </div>
      )}
    </Group>
  );
}

function LogTab({ titles }: { titles: Map<string, string> }): ReactElement {
  const [query, setQuery] = useState("");
  const [events, setEvents] = useState<{ id: number; ts: number; role: string; text: string; projectSlug: string | null; conversationId: string | null; caller: string; trust: string; shadowed: boolean }[]>([]);
  useEffect(() => {
    const handle = setTimeout(() => {
      void api.memoryLog(query || undefined, 60).then((r) => setEvents(r.events)).catch(() => setEvents([]));
    }, query ? 250 : 0);
    return () => clearTimeout(handle);
  }, [query]);
  return (
    <Group title="Log" blurb="Every message in and out, kept. Searched by words and by meaning at once; shadowed means out of a thread's context, still here.">
      <input className="list-search mem-search" placeholder="Search what was said…" value={query} onChange={(e) => setQuery(e.target.value)} />
      {events.length === 0 && <p className="hint">{query ? "Nothing matches." : "Nothing said yet."}</p>}
      {events.map((e) => (
        <div key={e.id} className={`mem-event ${e.shadowed ? "is-shadowed" : ""}`}>
          <div className="mem-event-meta">
            <Tag>{e.role}</Tag>
            {e.trust === "external" && <Pill tone="warn">via {e.caller}</Pill>}
            {e.projectSlug && <span className="ops-mono">{e.projectSlug}</span>}
            {e.conversationId && (
              <a className="ops-muted" href={`#/chats/${encodeURIComponent(e.conversationId)}`}>
                {titles.get(e.conversationId) ?? "a deleted chat"}
              </a>
            )}
            <span className="ops-muted">{when(e.ts)}</span>
          </div>
          <div className="mem-event-text">{e.text.length > 400 ? `${e.text.slice(0, 400)}…` : e.text}</div>
        </div>
      ))}
    </Group>
  );
}

const JOBS: { name: string; label: string; what: string }[] = [
  { name: "kos.memory", label: "Read", what: "reads what was said since it last looked and keeps what matters, citing its sources" },
  { name: "kos.dream", label: "Tidy", what: "merges duplicates, archives the stale, flags what it cannot settle, writes the pages" },
  { name: "kos.observe", label: "Condense", what: "stands a dated note in for the older part of a long thread" },
];

function JobsTab(): ReactElement {
  const [crons, setCrons] = useState<CronJob[]>([]);
  const [unread, setUnread] = useState<{ count: number; chars: number } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [said, setSaid] = useState<Record<number, string>>({});
  const load = useCallback(() => {
    void api.crons().then(setCrons).catch(() => setCrons([]));
    void api.memoryExtractStatus().then((s) => setUnread(s.pending)).catch(() => setUnread(null));
  }, []);
  useEffect(load, [load]);
  return (
    <Group title="Jobs" blurb="Memory is maintained by KOS itself, as scheduled jobs you can read, edit on the Schedule page, switch, and run now. Each runs on the model class it names.">
      {unread && <p className="hint">Unread by memory: {unread.count} messages, about {Math.round(unread.chars / 1000)}k characters.</p>}
      {JOBS.map((j) => {
        const job = crons.find((c) => c.name === j.name);
        if (!job) return null;
        return (
          <div key={j.name} className="mem-job">
            <div className="mem-job-main">
              <div className="mem-job-title">
                <strong>{j.label}</strong> <span className="ops-mono ops-muted">{j.name}</span>
                <Pill tone={job.enabled ? "ok" : "muted"}>{job.enabled ? "On schedule" : "Off"}</Pill>
              </div>
              <div className="hint">{j.what} · {job.schedule} · {job.task ?? "reasoning"} route{job.lastRunAt ? ` · last ran ${when(job.lastRunAt)}` : " · never run"}</div>
              {said[job.id] && <div className="mem-job-said">{said[job.id]}</div>}
            </div>
            <div className="mem-actions">
              <button type="button" className="btn btn--sm" disabled={busy === job.id} onClick={() => {
                setBusy(job.id);
                void api.runCron(job.id).then((r) => {
                  const text = (r as { outcome?: { result?: { finalText?: string } }; error?: string }).outcome?.result?.finalText ?? (r as { error?: string }).error ?? "ran";
                  setSaid((s) => ({ ...s, [job.id]: text }));
                }).catch((err: unknown) => setSaid((s) => ({ ...s, [job.id]: err instanceof Error ? err.message : String(err) }))).finally(() => { setBusy(null); load(); });
              }}>{busy === job.id ? "Running…" : "Run now"}</button>
              <Switch label={`${j.label} on schedule`} on={job.enabled} onChange={(on) => void api.setCronEnabled(job.id, on).then(load, load)} />
            </div>
          </div>
        );
      })}
      <p className="hint">Background extraction in Settings, Behaviour fires Read whenever enough is unread; these switches are the schedule.</p>
    </Group>
  );
}

function CallersTab(): ReactElement {
  const [callers, setCallers] = useState<CallerInfo[]>([]);
  const [draft, setDraft] = useState({ name: "", tags: "", writeGlobal: false });
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);
  const load = useCallback(() => {
    void api.callers().then((r) => setCallers(r.callers)).catch(() => setCallers([]));
  }, []);
  useEffect(load, [load]);
  return (
    <Group title="Callers" blurb="Another program with its own token and its own corner of memory. It reads your global claims only under the tags you grant, writes global only if you say so, and never sees a project or another caller. The token is shown once.">
      {issued && (
        <div className="mem-issued">
          <strong>Token for {issued.name}</strong>
          <p className="hint">Copy it now; it is not stored and cannot be shown again.</p>
          <code className="ops-mono">{issued.token}</code>
        </div>
      )}
      {callers.length === 0 && <Empty inline>No callers yet. Make one below and give the token to the other program.</Empty>}
      {callers.map((c) => (
        <div key={c.id} className="mem-row mem-row--split">
          <div>
            <strong>{c.name}</strong>
            <div className="hint">reads {c.readTags.length ? c.readTags.join(", ") : "nothing global"}{c.writeGlobal ? " · may write global" : ""}{c.lastSeenAt ? ` · last seen ${when(c.lastSeenAt)}` : " · never used"}</div>
          </div>
          <button type="button" className="btn btn--sm btn--danger" onClick={() => void api.revokeCaller(c.id).then(load, load)}>Revoke</button>
        </div>
      ))}
      <div className="mem-new">
        <input className="kos-input" placeholder="name, e.g. resume-ops" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        <input className="kos-input" placeholder="global tags it may read: career, resume (or *)" value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} />
        <label className="set-toggle">
          <Switch label="May write global" on={draft.writeGlobal} onChange={(on) => setDraft({ ...draft, writeGlobal: on })} />
          <span>May write global</span>
        </label>
        <button type="button" className="btn btn--primary" disabled={!draft.name.trim()} onClick={() => {
          const tags = draft.tags.split(",").map((t) => t.trim()).filter(Boolean);
          void api.createCaller(draft.name.trim(), tags, draft.writeGlobal).then((r) => { setIssued({ name: r.caller.name, token: r.token }); setDraft({ name: "", tags: "", writeGlobal: false }); load(); }).catch(() => undefined);
        }}>Create caller</button>
      </div>
    </Group>
  );
}
