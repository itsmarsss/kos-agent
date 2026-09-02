import {
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import {
  api,
  type ModelDaySpend,
  type ModelRate,
  type ModelSpend,
} from "./api.js";
import { fitInside, place, type Placement } from "./popover.js";
import { Select } from "./Select.js";

/**
 * What KOS has spent.
 *
 * Tokens are counted by the provider and are the honest part of this panel.
 * Money is not: prices change, differ by tier and by account, and a dollar
 * figure built into the code would go quietly wrong rather than loudly wrong.
 * So a rate is something you set, and a cost appears only for models you have
 * priced. A model you have not priced shows its tokens and says so.
 */

function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function money(n: number): string {
  return n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`;
}

const WINDOWS = [
  { value: "1", label: "Today" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "365", label: "Last year" },
];

export interface DayTotal {
  day: string;
  inputTokens: number;
  outputTokens: number;
}

/** Local calendar date as YYYY-MM-DD, matching what the query groups by. */
function isoDay(d: Date): string {
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}

/**
 * One entry per day of the window, including the quiet ones.
 *
 * The query groups by day and so returns only days that had usage. Two busy
 * days in a month came back as two bars, which drew a stub in the corner of a
 * wide chart and, worse, read as "the last two days" rather than "twice in a
 * month". The gaps are the information.
 */
export function padDays(
  rows: DayTotal[],
  windowDays: number,
  today = new Date(),
): DayTotal[] {
  const known = new Map(rows.map((r) => [r.day, r]));
  const out: DayTotal[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const day = isoDay(d);
    out.push(known.get(day) ?? { day, inputTokens: 0, outputTokens: 0 });
  }
  return out;
}

/** A bar per day, scaled to the busiest one. */
function Trend({
  days,
  byModelDay,
}: {
  days: DayTotal[];
  byModelDay: ModelDaySpend[];
}): ReactElement | null {
  if (days.length < 2) return null;
  const peak = Math.max(...days.map((d) => d.inputTokens + d.outputTokens));
  if (peak <= 0) return null;

  return (
    // Not aria-hidden any more: each bar is a real target with the day's
    // numbers behind it, so it is worth reaching by keyboard.
    <div className="spend-trend">
      {days.map((d) => {
        const total = d.inputTokens + d.outputTokens;
        const models = byModelDay
          .filter((m) => m.day === d.day)
          .sort(
            (a, b) =>
              b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
          );
        return (
          <HoverCard
            className="spend-bar-slot"
            key={d.day}
            card={<DayCard day={d} models={models} />}
          >
            <span
              className={`spend-bar ${total === 0 ? "is-empty" : ""}`}
              // A quiet day gets a hairline rather than nothing, so the axis
              // stays readable and a gap looks deliberate.
              style={{
                height: total === 0 ? "1px" : `${Math.max(2, (total / peak) * 100)}%`,
              }}
            />
          </HoverCard>
        );
      })}
    </div>
  );
}

/**
 * A card that appears beside whatever it wraps, on hover or on focus.
 *
 * Anchored with the same viewport placement the dropdowns use, and portalled
 * to the body: these live inside a card that scrolls, and an absolutely
 * positioned panel would be clipped by it.
 *
 * Keyboard reachable, because a chart whose only detail is behind a mouse
 * hover has no detail at all for anyone not using one.
 */
function HoverCard({
  card,
  children,
  className = "",
}: {
  /** Rendered into the floating panel. Null means there is nothing to say. */
  card: ReactNode;
  children: ReactNode;
  className?: string;
}): ReactElement {
  const [at, setAt] = useState<Placement | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);

  const show = (): void => {
    const rect = anchor.current?.getBoundingClientRect();
    if (rect && card) setAt(place(rect));
  };
  const hide = (): void => setAt(null);

  return (
    <span
      className={className}
      ref={anchor}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      tabIndex={card ? 0 : -1}
    >
      {children}
      {at &&
        createPortal(
          <div
            className="spend-pop"
            role="tooltip"
            // Measured once it exists: place() can only clamp by the width of
            // what it is anchored to, and a wide card on a narrow bar ran off
            // the side of the window.
            ref={(el) => {
              if (el) fitInside(el);
            }}
            style={{
              left: at.left,
              ...(at.top !== undefined ? { top: at.top } : {}),
              ...(at.bottom !== undefined ? { bottom: at.bottom } : {}),
              maxHeight: at.maxHeight,
            }}
          >
            {card}
          </div>,
          document.body,
        )}
    </span>
  );
}

/** The days behind a model's total. */
function DaysCard({ days }: { days: ModelDaySpend[] }): ReactElement {
  const busiest = Math.max(1, ...days.map((d) => d.inputTokens + d.outputTokens));
  return (
    <>
      <div className="spend-pop-head">
        {days.length} {days.length === 1 ? "day" : "days"} with usage
      </div>
      <ul className="spend-pop-list">
        {[...days].reverse().map((d) => {
          const total = d.inputTokens + d.outputTokens;
          return (
            <li key={d.day}>
              <span className="spend-pop-day">{d.day}</span>
              <span
                className="spend-pop-bar"
                style={{ width: `${(total / busiest) * 100}%` }}
              />
              <span className="spend-pop-num">
                {tokens(total)}
                {d.cost !== undefined ? ` \u00b7 ${money(d.cost)}` : ""}
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** One day of the chart: what it was made of, and which models made it. */
function DayCard({
  day,
  models,
}: {
  day: DayTotal;
  models: ModelDaySpend[];
}): ReactElement {
  const total = day.inputTokens + day.outputTokens;
  const calls = models.reduce((n, m) => n + m.calls, 0);
  const priced = models.filter((m) => m.cost !== undefined);
  const cost = priced.reduce((n, m) => n + (m.cost ?? 0), 0);

  return (
    <>
      <div className="spend-pop-head">
        {day.day}
        {/* Which model, even when there was only one. The split below is
            only drawn for a day with several, so a single-model day used to
            answer "how much" and never "what". */}
        {models.length === 1 && (
          <span className="spend-pop-only"> · {models[0]!.model}</span>
        )}
      </div>
      {total === 0 ? (
        <p className="spend-pop-none">Nothing ran.</p>
      ) : (
        <>
          <dl className="spend-pop-facts">
            <div>
              <dt>In</dt>
              <dd>{tokens(day.inputTokens)}</dd>
            </div>
            <div>
              <dt>Out</dt>
              <dd>{tokens(day.outputTokens)}</dd>
            </div>
            <div>
              <dt>Calls</dt>
              <dd>{calls}</dd>
            </div>
            <div>
              <dt>Cost</dt>
              {/* Only for the models priced: adding up a subset and calling
                  it the day's cost would understate it silently. */}
              <dd>
                {priced.length === 0
                  ? "no rate set"
                  : `${money(cost)}${priced.length < models.length ? "*" : ""}`}
              </dd>
            </div>
          </dl>
          {models.length > 1 && (
            <ul className="spend-pop-list spend-pop-list--models">
              {models.map((m) => (
                <li key={m.model}>
                  <span className="spend-pop-day">{m.model}</span>
                  <span
                    className="spend-pop-bar"
                    style={{
                      width: `${((m.inputTokens + m.outputTokens) / total) * 100}%`,
                    }}
                  />
                  <span className="spend-pop-num">
                    {tokens(m.inputTokens + m.outputTokens)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {priced.length > 0 && priced.length < models.length && (
            <p className="spend-pop-note">
              * only the {priced.length} of {models.length} models you have
              priced
            </p>
          )}
        </>
      )}
    </>
  );
}

export function SpendPanel(): ReactElement {
  const [days, setDays] = useState("30");
  const [data, setData] = useState<{
    models: ModelSpend[];
    byDay: { day: string; inputTokens: number; outputTokens: number }[];
    byModelDay: ModelDaySpend[];
    rates: Record<string, ModelRate>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, ModelRate>>({});
  const [saving, setSaving] = useState(false);

  const load = (window: string): void => {
    void api
      .spend(Number(window))
      .then((r) => {
        setData(r);
        setDraft(r.rates);
        setError(null);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  };

  useEffect(() => load(days), [days]);

  const save = (): void => {
    setSaving(true);
    void api
      .saveRates(draft)
      .then(() => {
        setEditing(false);
        load(days);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setSaving(false));
  };

  const models = data?.models ?? [];
  const totalIn = models.reduce((sum, m) => sum + m.inputTokens, 0);
  const totalOut = models.reduce((sum, m) => sum + m.outputTokens, 0);
  const priced = models.filter((m) => m.cost !== undefined);
  const totalCost = priced.reduce((sum, m) => sum + (m.cost ?? 0), 0);
  const unpriced = models.length - priced.length;

  const setRate = (key: string, field: keyof ModelRate, value: string): void => {
    const n = Number(value);
    setDraft((d) => ({
      ...d,
      [key]: {
        inputPerMillion: 0,
        outputPerMillion: 0,
        ...d[key],
        [field]: Number.isFinite(n) ? n : 0,
      },
    }));
  };

  return (
    <section className="spend">
      <header className="spend-head">
        <p className="hint">Costs use the rates you set below.</p>
        <Select
          className="spend-window"
          label="Period"
          value={days}
          options={WINDOWS}
          onChange={setDays}
        />
      </header>

      {error && (
        <p className="ops-alert ops-alert--err" role="alert">
          {error}
        </p>
      )}

      {data && models.length === 0 && (
        <p className="hint">Nothing spent in this period.</p>
      )}

      {models.length > 0 && (
        <>
          <div className="spend-totals">
            <div className="spend-stat">
              <span className="spend-stat-value">{tokens(totalIn)}</span>
              <span className="spend-stat-label">in</span>
            </div>
            <div className="spend-stat">
              <span className="spend-stat-value">{tokens(totalOut)}</span>
              <span className="spend-stat-label">out</span>
            </div>
            {priced.length > 0 && (
              <div className="spend-stat">
                <span className="spend-stat-value">{money(totalCost)}</span>
                <span className="spend-stat-label">
                  {unpriced > 0 ? `for ${priced.length} priced` : "estimated"}
                </span>
              </div>
            )}
          </div>

          <Trend
            days={padDays(data?.byDay ?? [], Number(days))}
            byModelDay={data?.byModelDay ?? []}
          />

          <table className="spend-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Calls</th>
                <th>In</th>
                <th>Out</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={`${m.provider}:${m.model}`}>
                  <td>
                    <span className="spend-model">{m.model}</span>
                    <span className="spend-provider">{m.provider}</span>
                  </td>
                  <td>{m.calls}</td>
                  <td>{tokens(m.inputTokens)}</td>
                  <td>{tokens(m.outputTokens)}</td>
                  <td>
                    {/* A total over thirty days is the one number you cannot
                        act on: it does not say whether that was steady or one
                        bad afternoon. Hovering opens the days behind it. */}
                    <HoverCard
                      className="spend-hover"
                      card={
                        <DaysCard
                          days={(data?.byModelDay ?? []).filter(
                            (d) =>
                              d.model === m.model && d.provider === m.provider,
                          )}
                        />
                      }
                    >
                      {m.cost === undefined ? (
                        <span className="hint">no rate set</span>
                      ) : (
                        money(m.cost)
                      )}
                      <span className="spend-hint" aria-hidden="true" />
                    </HoverCard>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <div className="spend-rates">
        <button
          type="button"
          className="btn"
          onClick={() => setEditing((e) => !e)}
        >
          {editing ? "Done" : "Set rates"}
        </button>
        {editing && (
          <div className="spend-rate-list">
            <p className="hint">
              Price per million tokens, from your provider's pricing page, and
              the model's context window if KOS does not already know it. A
              model with no rate shows tokens only rather than a made-up
              figure, and an unknown window means the chat meter shows a count
              without a percentage.
            </p>
            {models.map((m) => {
              const key = `${m.provider}:${m.model}`;
              const rate = draft[key];
              return (
                <div className="spend-rate" key={key}>
                  <span className="spend-rate-name">{m.model}</span>
                  <div className="spend-rate-fields">
                    <label className="spend-rate-field">
                      <span>$ / M in</span>
                      <input
                        className="kos-input kos-input--num"
                        inputMode="decimal"
                        value={rate?.inputPerMillion ?? ""}
                        placeholder="0.00"
                        onChange={(e) => setRate(key, "inputPerMillion", e.target.value)}
                      />
                    </label>
                    <label className="spend-rate-field">
                      <span>$ / M out</span>
                      <input
                        className="kos-input kos-input--num"
                        inputMode="decimal"
                        value={rate?.outputPerMillion ?? ""}
                        placeholder="0.00"
                        onChange={(e) => setRate(key, "outputPerMillion", e.target.value)}
                      />
                    </label>
                    <label className="spend-rate-field">
                      <span>Context window</span>
                      <input
                        className="kos-input kos-input--num"
                        inputMode="numeric"
                        value={rate?.contextWindow ?? ""}
                        placeholder="tokens"
                        onChange={(e) => setRate(key, "contextWindow", e.target.value)}
                      />
                    </label>
                  </div>
                </div>
              );
            })}
            <div>
              <button
                type="button"
                className="btn btn--primary"
                disabled={saving}
                onClick={save}
              >
                {saving ? "Saving…" : "Save rates"}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
