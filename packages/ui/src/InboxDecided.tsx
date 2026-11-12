import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { m } from "motion/react";

import { ChevronDown, Chips, Collapse, Count, Empty, Pill, spring, type Tone } from "@kos/kit";

import { api, type DecidedAction, type DecidedStatus, type InboxData } from "./api.js";
import { agoWords } from "./schedulewords.js";

/**
 * What the Inbox has already settled, kept so a link to an old ask lands.
 *
 * It listed fifty at full height under the asks still waiting, which pushed
 * those (and the memory questions) off the screen, and it read the latest
 * 500 whole on every poll. It is history, so it is quiet: the latest few,
 * one line each, older ones a page at a time, read again only when
 * something new was decided.
 */

/** Rows shown before any "Load older". */
export const DECIDED_FIRST = 5;
/** Rows each "Load older" adds. */
export const DECIDED_PAGE = 25;
/** Past this many, a search box earns its place. */
const SEARCH_FROM = 20;
/** A summary longer than this is cut on its row, so the details say it whole. */
const CUT_AT = 72;

type Filter = "all" | DecidedStatus;

const OUTCOME: Record<DecidedStatus, { word: string; tone: Tone }> = {
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

/** The words a search is held to, a moment after the last key. */
function useSettled(value: string, ms = 250): string {
  const [settled, setSettled] = useState(value.trim());
  useEffect(() => {
    const t = setTimeout(() => setSettled(value.trim()), value.trim() ? ms : 0);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

export function InboxDecided({
  mark,
  highlight,
  onOpenChat,
}: {
  /** How many were decided and the latest: the list is read again only when this changes. */
  mark?: InboxData["decided"];
  /** An approval a link pointed at: shown, opened and scrolled to. */
  highlight?: number;
  onOpenChat: (id: string) => void;
}): ReactElement | null {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const q = useSettled(query);
  const [rows, setRows] = useState<DecidedAction[]>([]);
  const [more, setMore] = useState(false);
  const [counts, setCounts] = useState<Record<DecidedStatus, number> | null>(null);
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  /** The ask a link points at, read on its own when it is not among the rows loaded. */
  const [linked, setLinked] = useState<DecidedAction | null>(null);
  /** How many rows the owner has paged to, kept when the list is read again. */
  const wanted = useRef(DECIDED_FIRST);
  const highlit = useRef<HTMLLIElement | null>(null);
  const markKey = mark ? `${mark.total}:${mark.latest ?? ""}` : "";

  // One more than asked for, so a page knows whether there is another after it.
  const page = useCallback(
    (limit: number, after?: DecidedAction) =>
      api.approvalHistory({
        limit: limit + 1,
        ...(after?.decidedAt != null ? { before: { decidedAt: after.decidedAt, id: after.id } } : {}),
        ...(filter !== "all" ? { status: filter } : {}),
        ...(q ? { q } : {}),
      }),
    [filter, q],
  );

  // The first pages, again whenever something new is decided or the filter changes.
  useEffect(() => {
    let cancelled = false;
    void page(wanted.current)
      .then((got) => {
        if (cancelled) return;
        setRows(got.slice(0, wanted.current));
        setMore(got.length > wanted.current);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [page, markKey]);

  useEffect(() => {
    let cancelled = false;
    void api
      .approvalCounts()
      .then((c) => {
        if (!cancelled) setCounts(c);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [markKey]);

  // A link to a decided ask: clear what would hide it, read it if it is not here, open it.
  // Once per ask linked to: what the owner does after that (a filter, a search) stands.
  const applied = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (highlight === undefined || applied.current === highlight) return;
    applied.current = highlight;
    setFilter("all");
    setQuery("");
    setOpen((s) => new Set(s).add(highlight));
    void api
      .approval(highlight)
      .then((a) => {
        if (applied.current === highlight && a.status !== "pending") setLinked(a);
      })
      .catch(() => undefined);
  }, [highlight]);

  const loadOlder = (): void => {
    const last = rows.at(-1);
    if (!last) return;
    void page(DECIDED_PAGE, last)
      .then((got) => {
        wanted.current = rows.length + DECIDED_PAGE;
        setRows((r) => [...r, ...got.slice(0, DECIDED_PAGE)]);
        setMore(got.length > DECIDED_PAGE);
      })
      .catch(() => undefined);
  };
  const showFewer = (): void => {
    wanted.current = DECIDED_FIRST;
    setRows((r) => r.slice(0, DECIDED_FIRST));
    setMore(true);
  };

  const total = counts ? counts.approved + counts.denied + counts.expired : (mark?.total ?? rows.length);
  // The linked ask heads the list while nothing is filtered; once the owner filters, the list is theirs.
  const shown = useMemo(
    () => (!linked || filter !== "all" || q || rows.some((r) => r.id === linked.id) ? rows : [linked, ...rows]),
    [rows, linked, filter, q],
  );
  // Scrolled to once its row is drawn, which may be a page or a read after the link arrived.
  const scrolledTo = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (highlight === undefined || scrolledTo.current === highlight || !highlit.current) return;
    scrolledTo.current = highlight;
    highlit.current.scrollIntoView({ block: "center" });
  }, [highlight, shown]);

  if (total === 0 && shown.length === 0) return null;
  const toggle = (id: number): void =>
    setOpen((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const countOf = (f: Filter): number => (f === "all" ? total : (counts?.[f] ?? 0));

  return (
    <section className="inbox-group inbox-group--decided" aria-labelledby="inbox-decided-title">
      <div className="inbox-group-head">
        <h2 className="inbox-group-title" id="inbox-decided-title">
          {/* With words to match, the total is not known: how many are here, and whether there are more. */}
          Decided {q ? <Count n={rows.length} more={more} /> : <Count n={countOf(filter)} />}
        </h2>
        <div className="inbox-decided-tools">
          {total > SEARCH_FROM && (
            <input
              className="list-search inbox-decided-search"
              type="search"
              aria-label="Search what was decided"
              placeholder="Search decided…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                wanted.current = DECIDED_FIRST;
              }}
            />
          )}
          <Chips
            small
            scroll
            label="Show decided"
            options={FILTERS.filter((f) => f.id === "all" || countOf(f.id) > 0).map((f) => [f.id, <>{f.label} <Count n={countOf(f.id)} /></>] as const)}
            selected={filter}
            onChoose={(f) => {
              setFilter(f);
              wanted.current = DECIDED_FIRST;
            }}
          />
        </div>
      </div>

      {shown.length === 0 ? (
        <Empty inline>
          Nothing decided matches.{" "}
          <button
            type="button"
            className="link"
            onClick={() => {
              setFilter("all");
              setQuery("");
              wanted.current = DECIDED_FIRST;
            }}
          >
            Clear
          </button>
        </Empty>
      ) : (
        <ul className="inbox-decided">
          {shown.map((a) => {
            const outcome = OUTCOME[a.status];
            const isOpen = open.has(a.id);
            const when = a.decidedAt ?? a.requestedAt;
            return (
              <li key={a.id} ref={a.id === highlight ? highlit : undefined} className={`inbox-decided-row${a.id === highlight ? " is-highlit" : ""}`}>
                <button type="button" className="inbox-decided-line" aria-expanded={isOpen} onClick={() => toggle(a.id)}>
                  <span className="inbox-decided-outcome">
                    <Pill tone={outcome.tone}>{outcome.word}</Pill>
                  </span>
                  <span className="inbox-decided-what">{a.summary}</span>
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
                    {a.summary.length > CUT_AT && <p className="inbox-decided-full">{a.summary}</p>}
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

      {(more || rows.length > DECIDED_FIRST) && (
        <div className="inbox-decided-more">
          {more && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={loadOlder}>
              Load older
            </button>
          )}
          {rows.length > DECIDED_FIRST && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={showFewer}>
              Show fewer
            </button>
          )}
        </div>
      )}
    </section>
  );
}
