import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";

import { Chips, EmptyState, Pill, Switch, Tag } from "@kos/kit";
import { kindWord, momentWords, slugWords, timeWords } from "@kos/shared";

import { api, type CallerInfo, type CronJob, type FactRow, type MemoryChange, type ReviewClaim, type ReviewItem, type Conversation } from "./api.js";
import { KnowledgePage } from "./KnowledgePage.js";
import { PageHead, PageTabs, tabId } from "./PageHead.js";
import { useHashParam } from "./hashparams.js";
import { hrefFor } from "./routes.js";
import { scheduleWords } from "./schedule.js";
import { jobTitle, lastRunWords } from "./schedulewords.js";

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
  { id: "claims", label: "What it knows", blurb: "Each thing KOS believes (a claim), for every chat to read: true everywhere or in one project, with where it came from." },
  { id: "decisions", label: "To decide", blurb: "What KOS was not sure enough to settle when it tidied memory, what you settled, and every change to what it believes." },
  { id: "pages", label: "Notes", blurb: "Memory written out as notes, from what KOS knows. Yours to edit." },
  { id: "log", label: "Everything said", blurb: "Every message to and from KOS, kept, and searched by words or by meaning." },
  { id: "jobs", label: "Upkeep", blurb: "The three schedules that keep memory up: reading what was said, tidying it, and condensing long chats." },
  { id: "callers", label: "Other apps", blurb: "Other programs you let share KOS's memory, and what each may see." },
];

export function MemoryPage({
  facts,
  tags,
  conversations = [],
  projectNames,
  loading = false,
  onChanged,
}: {
  facts: FactRow[];
  /** The claims have not been read yet: the page draws where they will be. */
  loading?: boolean;
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
  // An address that names a tab (a search hit, a turn's claims) opens it, here already or not.
  const [asked] = useHashParam("tab");
  useEffect(() => {
    const named = TABS.find((t) => t.id === asked);
    if (named) setTab(named.id);
  }, [asked]);
  /** Another tab leaves a turn's claims behind: back on Claims, every claim shows. */
  const choose = (next: Tab): void => {
    if (/[?&]ids=/.test(window.location.hash)) history.replaceState(null, "", `${hrefFor({ name: "memory" })}?tab=${next}`);
    setTab(next);
  };
  /** The new-claim form, opened from the page head. */
  const [adding, setAdding] = useState(false);
  // The head's search is the open tab's: the claims', or the log's.
  const [claimsQuery, setClaimsQuery] = useState("");
  const [logQuery, setLogQuery] = useState("");
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
              search: { value: claimsQuery, onChange: setClaimsQuery, noun: "claims" },
              actions: (
                <button type="button" className="btn btn--primary" onClick={() => setAdding(true)}>
                  New claim
                </button>
              ),
            }
          : tab === "log"
            ? { search: { value: logQuery, onChange: setLogQuery, noun: "the log" } }
            : {})}
        tabs={
          <PageTabs
            label="Memory"
            current={tab}
            controls="mem-panel"
            onChoose={(id) => choose(id as Tab)}
            tabs={TABS.map((t) => ({
              id: t.id,
              label: (
                <>
                  {t.label}
                  {t.id === "decisions" && pendingCount > 0 && <Pill tone="warn">{pendingCount}</Pill>}
                </>
              ),
            }))}
          />
        }
      />
      <div id="mem-panel" role="tabpanel" aria-labelledby={tabId("Memory", tab)} className="mem-panel">
      {tab === "claims" && <KnowledgePage facts={facts} tags={tags} adding={adding} onAdding={setAdding} query={claimsQuery} onQuery={setClaimsQuery} {...(projectNames ? { projectNames } : {})} loading={loading} onChanged={onChanged} />}
      {tab === "decisions" && <DecisionsTab onChanged={onChanged} />}
      {tab === "pages" && <PagesTab />}
      {tab === "log" && <LogTab titles={titles} query={logQuery} {...(projectNames ? { projectNames } : {})} />}
      {tab === "jobs" && <JobsTab />}
      {tab === "callers" && <CallersTab />}
      </div>
    </div>
  );
}

/** A tab's section; `title` is left out where it would only repeat the tab's own name, and kept for its region's name. */
function Group({ title, shown = true, blurb, children }: { title: string; shown?: boolean; blurb?: string; children: React.ReactNode }): ReactElement {
  return (
    <section className="mem-group" aria-label={title}>
      <div className="mem-group-head">
        {shown && <h2>{title}</h2>}
        {blurb && <p className="hint">{blurb}</p>}
      </div>
      {children}
    </section>
  );
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
    return { words: `keep the ${scope === "global" ? "everywhere" : scope.replace(/^project:/, "")} one`, action: "keep", key: keep[1]! };
  }
  const plain = lean.toLowerCase();
  if (plain === "both") return { words: "leave them both", action: "both" };
  if (plain === "promote") return { words: "make it true everywhere", action: "promote" };
  if (plain === "dismiss") return { words: "keep it to the project", action: "dismiss" };
  return null;
}

/** How a claim is leaned on, for the hover: it was a line of its own and made every card a read. */
function metaOf(c: ReviewClaim): string {
  return [
    c.kind,
    c.trust && c.trust !== "owner" ? `from ${c.trust === "agent" ? "KOS" : c.trust}` : null,
    c.useCount ? `used ${c.useCount}×${c.lastUsedAt ? `, last ${timeWords(c.lastUsedAt)}` : ""}` : "never used",
    c.createdAt ? `written ${timeWords(c.createdAt)}` : null,
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
                Yes, make it true everywhere
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

/** What a change did, in a word, for its tag. */
const CHANGE_WORD: Record<MemoryChange["action"], string> = { supersede: "changed", merge: "merged", archive: "archived" };

/**
 * One change to a claim, as a diff: what it said before, struck, and what
 * it says now; for an archive, what was put away and why.
 */
function ChangeRow({ change }: { change: MemoryChange }): ReactElement {
  const scope = change.scope === "global" ? "" : change.scope.replace(/^project:/, "");
  return (
    <li className="mem-change">
      <div className="mem-settled-row">
        <Tag>{CHANGE_WORD[change.action]}</Tag>
        <span className="mem-settled-keys">
          <span className="mem-settled-key">
            {scope && <span className="mem-scope">{scope}</span>}
            {change.key}
          </span>
        </span>
        {change.by && <span className="mem-settled-how">{change.by}</span>}
        <time className="mem-settled-when">{momentWords(change.at)}</time>
      </div>
      <div className="mem-change-diff">
        {change.action === "archive" ? (
          <>
            <del><Clamp text={change.value} chars={160} /></del>
            {change.reason && <span className="mem-change-why">{change.reason}</span>}
          </>
        ) : (
          <>
            {change.was && <del><Clamp text={change.was} chars={160} /></del>}
            <ins><Clamp text={change.value} chars={160} /></ins>
          </>
        )}
      </div>
    </li>
  );
}

function DecisionsTab({ onChanged }: { onChanged: () => void }): ReactElement {
  const [pending, setPending] = useState<ReviewItem[]>([]);
  const [recent, setRecent] = useState<ReviewItem[]>([]);
  const [changes, setChanges] = useState<MemoryChange[]>([]);
  const [allSettled, setAllSettled] = useState(false);
  const [allChanges, setAllChanges] = useState(false);
  const load = useCallback(() => {
    void api.memoryReview().then((r) => { setPending(r.pending); setRecent(r.recent.filter((i) => i.resolvedAt !== null)); }).catch(() => undefined);
    void api.memoryChanges().then((r) => setChanges(r.changes)).catch(() => undefined);
  }, []);
  useEffect(load, [load]);
  return (
    <>
      <Group title="Needs a decision" blurb="Only what KOS was not sure enough to settle itself. Keeping one side puts the other away; making one true everywhere moves it out of its project. Either is kept on the record as your choice.">
        {pending.length === 0 && <EmptyState variant="inline">Nothing to decide. When KOS tidies memory it settles what it is sure of and leaves here only what it is not. How sure it must be is in Settings, Behaviour.</EmptyState>}
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
                {item.resolvedAt ? <time className="mem-settled-when">{momentWords(item.resolvedAt)}</time> : null}
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
      {changes.length > 0 && (
        <Group title="Changes" blurb="Every claim a job, a chat or you changed, merged or put away, newest first, with what it said before. History keeps the old value; a wrong change is undone by saying the claim again.">
          <ul className="mem-settled">
            {(allChanges ? changes : changes.slice(0, SETTLED_FIRST)).map((c) => <ChangeRow key={c.id} change={c} />)}
          </ul>
          {changes.length > SETTLED_FIRST && (
            <button type="button" className="btn btn--sm btn--ghost mem-settled-more" onClick={() => setAllChanges((v) => !v)}>
              {allChanges ? "Show fewer" : `Show all ${changes.length}`}
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
  // A page the address names (a search hit): opened once, and taken off the address.
  const [named, clearNamed] = useHashParam("page");
  useEffect(() => {
    if (!named) return;
    clearNamed();
    void api.memoryPage(named).then(setOpen).catch(() => undefined);
  }, [named, clearNamed]);
  return (
    <Group title="Pages" shown={false} blurb={'One note for everywhere and one per project, written from what KOS knows each time it tidies memory. Edit a line written as "- name: value" and KOS reads it back as yours.'}>
      {pages.length === 0 && <EmptyState variant="inline">No notes yet. KOS writes them when it tidies memory; press Run now on the Upkeep tab rather than wait for 4 AM.</EmptyState>}
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

/** Who said a line of the log, by the names the Words table gives: KOS's replies are KOS's. */
function speaker(role: string): string {
  if (role === "agent" || role === "assistant") return "KOS";
  if (role === "user" || role === "owner") return "You";
  return kindWord(role);
}

function LogTab({ titles, query, projectNames }: { titles: Map<string, string>; query: string; projectNames?: ReadonlyMap<string, string> }): ReactElement {
  const [events, setEvents] = useState<{ id: number; ts: number; role: string; text: string; projectSlug: string | null; conversationId: string | null; caller: string; trust: string; shadowed: boolean }[]>([]);
  useEffect(() => {
    const handle = setTimeout(() => {
      void api.memoryLog(query || undefined, 60).then((r) => setEvents(r.events)).catch(() => setEvents([]));
    }, query ? 250 : 0);
    return () => clearTimeout(handle);
  }, [query]);
  return (
    <Group title="Log" shown={false} blurb="Every message in and out, kept, and searched by words and by meaning at once. A faded one has dropped out of its chat's view, and is still kept here.">
      {events.length === 0 && (query ? <EmptyState variant="inline" query={{ noun: "messages" }} /> : <EmptyState variant="inline">Nothing said yet.</EmptyState>)}
      {events.map((e) => (
        <div key={e.id} className={`mem-event ${e.shadowed ? "is-shadowed" : ""}`}>
          <div className="mem-event-meta">
            <Tag>{speaker(e.role)}</Tag>
            {e.trust === "external" && <Pill tone="warn">via {e.caller}</Pill>}
            {e.projectSlug && <span className="ops-muted" title={e.projectSlug}>{projectNames?.get(e.projectSlug) ?? slugWords(e.projectSlug)}</span>}
            {e.conversationId && (
              <a className="link link--quiet" href={`#/chats/${encodeURIComponent(e.conversationId)}`}>
                {titles.get(e.conversationId) ?? "a deleted chat"}
              </a>
            )}
            <span className="ops-muted">{momentWords(e.ts)}</span>
          </div>
          <div className="mem-event-text">{e.text.length > 400 ? `${e.text.slice(0, 400)}…` : e.text}</div>
        </div>
      ))}
    </Group>
  );
}

const JOBS: { name: string; what: string }[] = [
  { name: "kos.memory", what: "reads what was said since it last looked and keeps what matters, citing its sources" },
  { name: "kos.dream", what: "merges duplicates, archives the stale, flags what it cannot settle, writes the pages" },
  { name: "kos.observe", what: "stands a dated note in for the older part of a long thread" },
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
    <Group title="Memory's schedules" blurb="KOS keeps its memory itself, on these schedules. Switch them off or run them now here; change when they run under Runs, Schedule.">
      {unread && <p className="hint">Unread by memory: {unread.count} messages, about {Math.round(unread.chars / 1000)}k characters.</p>}
      {JOBS.map((j) => {
        const job = crons.find((c) => c.name === j.name);
        if (!job) return null;
        return (
          <div key={j.name} className="mem-job">
            <div className="mem-job-main">
              <div className="mem-job-title">
                <strong title={j.name}>{jobTitle(j.name)}</strong>
              </div>
              <div className="hint">
                {j.what} · <span title={job.schedule}>{scheduleWords(job.schedule)}</span> · {job.task === "cheap" ? "the cheap model" : "the model for thinking"} · {job.lastRunAt ? `last run ${lastRunWords(job.lastRunAt)}` : "never run"}
              </div>
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
              <Switch label={`${jobTitle(j.name)} on`} on={job.enabled} onChange={(on) => void api.setCronEnabled(job.id, on).then(load, load)} />
            </div>
          </div>
        );
      })}
      <p className="hint">Settings, Behaviour can also start Memory: Read whenever enough is unread; these switches are its schedule.</p>
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
    <Group title="Other apps" shown={false} blurb="Another program with its own key and a corner of memory of its own. It sees what KOS knows about you only under the tags you allow, adds to it only if you say so, and never sees a project or another app. Its key is shown once.">
      {issued && (
        <div className="mem-issued">
          <strong>Key for {issued.name}</strong>
          <p className="hint">Copy it now; it is not stored and cannot be shown again.</p>
          <code className="ops-mono">{issued.token}</code>
        </div>
      )}
      {callers.length === 0 && <EmptyState variant="inline">No other apps yet. Make one below and give its key to the other program.</EmptyState>}
      {callers.map((c) => (
        <div key={c.id} className="mem-row mem-row--split">
          <div>
            <strong>{c.name}</strong>
            <div className="hint">sees {c.readTags.length ? c.readTags.join(", ") : "nothing of yours"}{c.writeGlobal ? " · may add to what KOS knows" : ""}{c.lastSeenAt ? ` · last seen ${momentWords(c.lastSeenAt)}` : " · never used"}</div>
          </div>
          <button type="button" className="btn btn--sm btn--danger" onClick={() => void api.revokeCaller(c.id).then(load, load)}>Revoke</button>
        </div>
      ))}
      <div className="mem-new">
        <input className="kos-input" placeholder="Its name, such as resume-ops" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        <input className="kos-input" placeholder="Tags it may see: career, resume (or * for all)" value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} />
        <label className="set-toggle">
          <Switch label="May add to what KOS knows" on={draft.writeGlobal} onChange={(on) => setDraft({ ...draft, writeGlobal: on })} />
          <span>May add to what KOS knows</span>
        </label>
        <button type="button" className="btn btn--primary" disabled={!draft.name.trim()} onClick={() => {
          const tags = draft.tags.split(",").map((t) => t.trim()).filter(Boolean);
          void api.createCaller(draft.name.trim(), tags, draft.writeGlobal).then((r) => { setIssued({ name: r.caller.name, token: r.token }); setDraft({ name: "", tags: "", writeGlobal: false }); load(); }).catch(() => undefined);
        }}>Create</button>
      </div>
    </Group>
  );
}
