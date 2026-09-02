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
import { place, Select, type Placement } from "./Select.js";

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
function Trend({ days }: { days: DayTotal[] }): ReactElement | null {
  if (days.length < 2) return null;
  const peak = Math.max(...days.map((d) => d.inputTokens + d.outputTokens));
  if (peak <= 0) return null;

  return (
    <div className="spend-trend" aria-hidden="true">
      {days.map((d) => {
        const total = d.inputTokens + d.outputTokens;
        return (
          <div className="spend-bar-slot" key={d.day}>
            <div
              className={`spend-bar ${total === 0 ? "is-empty" : ""}`}
              title={
                total === 0
                  ? `${d.day}: nothing`
                  : `${d.day}: ${tokens(total)} tokens`
              }
              // A quiet day gets a hairline rather than nothing, so the axis
              // stays readable and a gap looks deliberate.
              style={{ height: total === 0 ? "1px" : `${Math.max(2, (total / peak) * 100)}%` }}
            />
          </div>
        );
      })}
    </div>
  );
}

/**
 * The days behind a total, on hover.
 *
 * Anchored with the same viewport placement the dropdowns use, and portalled,
 * because a table cell is inside a card that scrolls and an absolutely
 * positioned panel would be clipped by it.
 */
function Breakdown({
  days,
  children,
}: {
  days: ModelDaySpend[];
  children: ReactNode;
}): ReactElement {
  const [at, setAt] = useState<Placement | null>(null);
  const cell = useRef<HTMLSpanElement>(null);

  const busiest = Math.max(1, ...days.map((d) => d.inputTokens + d.outputTokens));
  const show = (): void => {
    const rect = cell.current?.getBoundingClientRect();
    if (rect && days.length > 0) setAt(place(rect));
  };

  return (
    <span
      className="spend-hover"
      ref={cell}
      onMouseEnter={show}
      onMouseLeave={() => setAt(null)}
      onFocus={show}
      onBlur={() => setAt(null)}
      tabIndex={days.length > 0 ? 0 : -1}
    >
      {children}
      {days.length > 0 && <span className="spend-hint" aria-hidden="true" />}
      {at &&
        createPortal(
          <div
            className="spend-pop"
            role="tooltip"
            style={{
              left: at.left,
              ...(at.top !== undefined ? { top: at.top } : {}),
              ...(at.bottom !== undefined ? { bottom: at.bottom } : {}),
              maxHeight: at.maxHeight,
            }}
          >
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
                      {d.cost !== undefined ? ` · ${money(d.cost)}` : ""}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>,
          document.body,
        )}
    </span>
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

          <Trend days={padDays(data?.byDay ?? [], Number(days))} />

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
                    <Breakdown
                      days={(data?.byModelDay ?? []).filter(
                        (d) => d.model === m.model && d.provider === m.provider,
                      )}
                    >
                      {m.cost === undefined ? (
                        <span className="hint">no rate set</span>
                      ) : (
                        money(m.cost)
                      )}
                    </Breakdown>
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
