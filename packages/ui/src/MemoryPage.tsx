import { useCallback, useEffect, useState, type ReactElement } from "react";

import { api, type CallerInfo, type CronJob, type FactRow, type ReviewItem } from "./api.js";
import { KnowledgePage } from "./KnowledgePage.js";

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
  { id: "claims", label: "Claims", blurb: "what KOS believes, by scope and tag" },
  { id: "decisions", label: "Decisions", blurb: "what the dream job could not settle" },
  { id: "pages", label: "Pages", blurb: "memory in prose, yours to edit" },
  { id: "log", label: "Log", blurb: "everything said, by words and meaning" },
  { id: "jobs", label: "Jobs", blurb: "the three that read, tidy and condense" },
  { id: "callers", label: "Callers", blurb: "other programs, and what each may see" },
];

export function MemoryPage({ facts, tags, onChanged }: { facts: FactRow[]; tags: string[]; onChanged: () => void }): ReactElement {
  const [tab, setTab] = useState<Tab>(() => {
    const m = /[?&]tab=([a-z]+)/.exec(window.location.hash);
    return (TABS.find((t) => t.id === m?.[1])?.id ?? "claims");
  });
  const [pendingCount, setPendingCount] = useState(0);
  useEffect(() => {
    void api.memoryReview().then((r) => setPendingCount(r.pending.length)).catch(() => undefined);
  }, [tab]);
  return (
    <div className="mem">
      <nav className="mem-tabs" aria-label="Memory">
        {TABS.map((t) => (
          <button key={t.id} type="button" className={`mem-tab ${tab === t.id ? "is-active" : ""}`} onClick={() => setTab(t.id)} title={t.blurb}>
            {t.label}
            {t.id === "decisions" && pendingCount > 0 && <span className="mem-badge">{pendingCount}</span>}
          </button>
        ))}
      </nav>
      {tab === "claims" && <KnowledgePage facts={facts} tags={tags} onChanged={onChanged} />}
      {tab === "decisions" && <DecisionsTab onChanged={onChanged} />}
      {tab === "pages" && <PagesTab />}
      {tab === "log" && <LogTab />}
      {tab === "jobs" && <JobsTab />}
      {tab === "callers" && <CallersTab />}
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

function DecisionsTab({ onChanged }: { onChanged: () => void }): ReactElement {
  const [pending, setPending] = useState<ReviewItem[]>([]);
  const [recent, setRecent] = useState<ReviewItem[]>([]);
  const load = useCallback(() => {
    void api.memoryReview().then((r) => { setPending(r.pending); setRecent(r.recent.filter((i) => i.resolvedAt !== null)); }).catch(() => undefined);
  }, []);
  useEffect(load, [load]);
  return (
    <>
      <Group title="Needs a decision" blurb="Keeping one side archives the other; promoting writes the claim global. Both are on the record as yours.">
        {pending.length === 0 && <p className="hint">Nothing waiting. The dream job flags a contradiction it cannot settle, or a project claim that may be true everywhere.</p>}
        {pending.map((item) => (
          <div key={item.id} className="mem-decision">
            <div>
              <span className="mem-kind">{item.kind}</span> <span className="ops-mono">{item.keys.join(" vs ")}</span>
              <div className="hint">{item.note}</div>
            </div>
            <div className="mem-actions">
              {(item.kind === "promotion"
                ? [{ label: "promote to global", action: "promote" as const }, { label: "keep as is", action: "dismiss" as const }]
                : [...item.keys.map((k) => ({ label: `keep ${k}`, action: "keep" as const, key: k })), { label: "both are right", action: "both" as const }]
              ).map((choice) => (
                <button key={choice.label} type="button" className="btn btn--sm" onClick={() => void api.resolveMemoryReview(item.id, choice.action, "key" in choice ? choice.key : undefined).then(() => { load(); onChanged(); }, load)}>
                  {choice.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </Group>
      {recent.length > 0 && (
        <Group title="Settled">
          {recent.map((item) => (
            <div key={item.id} className="mem-row">
              <span className="mem-kind">{item.kind}</span> <span className="ops-mono">{item.keys.join(" vs ")}</span>
              <span className="ops-muted"> · {item.resolution} · {item.resolvedAt ? when(item.resolvedAt) : ""}</span>
            </div>
          ))}
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
      {pages.length === 0 && <p className="hint">No pages yet. The dream job writes them; Run now on the Jobs tab if you do not want to wait for 4am.</p>}
      {edited.length > 0 && (
        <p className="hint">
          Edited since memory wrote them: {edited.join(", ")}.{" "}
          <button type="button" className="btn btn--sm" onClick={() => void api.importMemoryPages().then(load, load)}>Read edits into memory</button>
        </p>
      )}
      <div className="mem-chips">
        {pages.map((p) => (
          <button key={p.name} type="button" className={`btn btn--sm ${open?.name === p.name ? "is-active" : ""}`} onClick={() => void api.memoryPage(p.name).then(setOpen).catch(() => undefined)}>
            {p.name}{edited.includes(p.name) ? " (edited)" : ""}
          </button>
        ))}
      </div>
      {open && (
        <div className="mem-page">
          <div className="hint ops-mono">memory/{open.name}.md</div>
          <pre className="know-page">{open.markdown}</pre>
        </div>
      )}
    </Group>
  );
}

function LogTab(): ReactElement {
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
            <span className="mem-kind">{e.role}</span>
            {e.trust === "external" && <span className="mem-kind mem-kind--outside">via {e.caller}</span>}
            {e.projectSlug && <span className="ops-mono">{e.projectSlug}</span>}
            {e.conversationId && <a className="ops-muted" href={`#/chats/${encodeURIComponent(e.conversationId)}`}>{e.conversationId}</a>}
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
                <span className={`cron-badge ${job.enabled ? "is-on" : "is-off"}`}>{job.enabled ? "On schedule" : "Off"}</span>
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
              <label className="set-toggle">
                <input type="checkbox" checked={job.enabled} onChange={(e) => void api.setCronEnabled(job.id, e.target.checked).then(load, load)} />
                <span>{job.enabled ? "On" : "Off"}</span>
              </label>
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
      {callers.map((c) => (
        <div key={c.id} className="mem-row mem-row--split">
          <div>
            <strong>{c.name}</strong>
            <div className="hint">reads {c.readTags.length ? c.readTags.join(", ") : "nothing global"}{c.writeGlobal ? " · may write global" : ""}{c.lastSeenAt ? ` · last seen ${when(c.lastSeenAt)}` : " · never used"}</div>
          </div>
          <button type="button" className="btn btn--sm btn--danger-ghost" onClick={() => void api.revokeCaller(c.id).then(load, load)}>Revoke</button>
        </div>
      ))}
      <div className="mem-new">
        <input className="kos-input" placeholder="name, e.g. resume-ops" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        <input className="kos-input" placeholder="global tags it may read: career, resume (or *)" value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} />
        <label className="set-toggle">
          <input type="checkbox" checked={draft.writeGlobal} onChange={(e) => setDraft({ ...draft, writeGlobal: e.target.checked })} />
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
