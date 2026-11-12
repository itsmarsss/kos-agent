import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { m } from "motion/react";
import { summarizeAction } from "@kos/shared";

import { ChevronDown, Chips, Collapse, Count, Empty, Pill, spring, type Tone } from "@kos/kit";

import type { DecidedAction } from "./api.js";
import { agoWords } from "./schedulewords.js";

/**
 * What the Inbox has already settled, kept so a link to an old ask lands.
 *
 * It listed fifty at full height under the asks still waiting, which pushed
 * those (and the memory questions) off the screen. It is history, so it is
 * quiet: the latest few, one line each, more a press away.
 */

/** Rows shown before any "Show more". */
export const DECIDED_FIRST = 5;
/** Rows each "Show more" adds. */
export const DECIDED_PAGE = 20;
/** Past this many, a search box earns its place. */
const SEARCH_FROM = 20;
/** A summary longer than this is cut on its row, so the details say it whole. */
const CUT_AT = 72;

type Outcome = DecidedAction["status"];
type Filter = "all" | Outcome;

const OUTCOME: Record<Outcome, { word: string; tone: Tone }> = {
  approved: { word: "approved", tone: "ok" },
  denied: { word: "denied", tone: "danger" },
  expired: { word: "lapsed", tone: "muted" },
};

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "approved", label: "Approved" },
  { id: "denied", label: "Denied" },
  { id: "expired", label: "Lapsed" },
];

function summaryOf(a: DecidedAction): string {
  return a.summary ?? summarizeAction(a.tool, a.args);
}

export function InboxDecided({
  rows,
  highlight,
  onOpenChat,
}: {
  rows: DecidedAction[];
  /** An approval a link pointed at: shown, opened and scrolled to. */
  highlight?: number;
  onOpenChat: (id: string) => void;
}): ReactElement | null {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(DECIDED_FIRST);
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  const highlit = useRef<HTMLLIElement | null>(null);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: rows.length, approved: 0, denied: 0, expired: 0 };
    for (const r of rows) c[r.status] += 1;
    return c;
  }, [rows]);

  const matched = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter !== "all" && r.status !== filter) return false;
      if (!q) return true;
      return [summaryOf(r), r.tool, r.asker ?? "", `#${r.id}`].some((s) => s.toLowerCase().includes(q));
    });
  }, [rows, filter, query]);

  // A link to a decided ask: clear what would hide it, page down to it, open it.
  useEffect(() => {
    if (highlight === undefined) return;
    const at = rows.findIndex((r) => r.id === highlight);
    if (at < 0) return;
    setFilter("all");
    setQuery("");
    setShown((n) => Math.max(n, at + 1));
    setOpen((s) => new Set(s).add(highlight));
  }, [highlight, rows]);
  useEffect(() => {
    highlit.current?.scrollIntoView({ block: "center" });
  }, [highlight, shown]);

  if (rows.length === 0) return null;
  const visible = matched.slice(0, shown);
  const left = matched.length - visible.length;
  const toggle = (id: number): void =>
    setOpen((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <section className="inbox-group inbox-group--decided" aria-labelledby="inbox-decided-title">
      <div className="inbox-group-head">
        <h2 className="inbox-group-title" id="inbox-decided-title">
          Decided <Count n={rows.length} />
        </h2>
        <div className="inbox-decided-tools">
          {rows.length > SEARCH_FROM && (
            <input
              className="list-search inbox-decided-search"
              type="search"
              aria-label="Search what was decided"
              placeholder="Search decided…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setShown(DECIDED_FIRST);
              }}
            />
          )}
          <Chips
            small
            label="Show decided"
            options={FILTERS.filter((f) => f.id === "all" || counts[f.id] > 0).map((f) => [f.id, <>{f.label} <Count n={counts[f.id]} /></>] as const)}
            selected={filter}
            onChoose={(f) => {
              setFilter(f);
              setShown(DECIDED_FIRST);
            }}
          />
        </div>
      </div>

      {visible.length === 0 ? (
        <Empty inline>Nothing decided matches.</Empty>
      ) : (
        <ul className="inbox-decided">
          {visible.map((a) => {
            const outcome = OUTCOME[a.status];
            const isOpen = open.has(a.id);
            const when = a.decidedAt ?? a.requestedAt;
            return (
              <li key={a.id} ref={a.id === highlight ? highlit : undefined} className={`inbox-decided-row${a.id === highlight ? " is-highlit" : ""}`}>
                <button type="button" className="inbox-decided-line" aria-expanded={isOpen} onClick={() => toggle(a.id)}>
                  <span className="inbox-decided-outcome">
                    <Pill tone={outcome.tone}>{outcome.word}</Pill>
                  </span>
                  <span className="inbox-decided-what">{summaryOf(a)}</span>
                  {a.asker && <span className="inbox-decided-where">{a.asker}</span>}
                  <time className="inbox-decided-when" dateTime={new Date(when).toISOString()} title={new Date(when).toLocaleString()}>
                    {agoWords(when)}
                  </time>
                  <m.span className="chev" animate={{ rotate: isOpen ? 180 : 0 }} transition={spring}>
                    <ChevronDown size={12} />
                  </m.span>
                </button>
                <Collapse open={isOpen}>
                  <div className="inbox-decided-detail">
                    {summaryOf(a).length > CUT_AT && <p className="inbox-decided-full">{summaryOf(a)}</p>}
                    <dl className="inbox-decided-facts">
                      <dt>Tool</dt>
                      <dd>
                        <code>{a.tool}</code> <span className="inbox-decided-id">#{a.id}</span>
                      </dd>
                      {a.asker && (
                        <>
                          <dt>Asked by</dt>
                          <dd>{a.asker}</dd>
                        </>
                      )}
                      <dt>Asked</dt>
                      <dd>{new Date(a.requestedAt).toLocaleString()}</dd>
                      <dt>{outcome.word[0]!.toUpperCase() + outcome.word.slice(1)}</dt>
                      <dd>
                        {a.decidedAt ? new Date(a.decidedAt).toLocaleString() : "unknown"}
                        {a.decidedBy ? ` by ${a.decidedBy}` : ""}
                      </dd>
                      {a.reason && (
                        <>
                          <dt>Why it asked</dt>
                          <dd>{a.reason}</dd>
                        </>
                      )}
                    </dl>
                    {a.why && <p className="inbox-said">{a.why}</p>}
                    {a.conversationId && (
                      <button type="button" className="btn btn--sm inbox-decided-open" onClick={() => onOpenChat(a.conversationId!)}>
                        Open the chat
                      </button>
                    )}
                  </div>
                </Collapse>
              </li>
            );
          })}
        </ul>
      )}

      {(left > 0 || shown > DECIDED_FIRST) && (
        <div className="inbox-decided-more">
          {left > 0 && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setShown((n) => n + DECIDED_PAGE)}>
              Show {Math.min(left, DECIDED_PAGE)} more
            </button>
          )}
          {left > DECIDED_PAGE && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setShown(matched.length)}>
              Show all {matched.length}
            </button>
          )}
          {shown > DECIDED_FIRST && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setShown(DECIDED_FIRST)}>
              Show fewer
            </button>
          )}
        </div>
      )}
    </section>
  );
}
