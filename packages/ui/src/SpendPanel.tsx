import { useEffect, useState, type ReactElement } from "react";

import { api, type ModelRate, type ModelSpend } from "./api.js";
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

/** A bar per day, scaled to the busiest one. */
function Trend({
  days,
}: {
  days: { day: string; inputTokens: number; outputTokens: number }[];
}): ReactElement | null {
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
              className="spend-bar"
              title={`${d.day}: ${tokens(total)} tokens`}
              style={{ height: `${Math.max(2, (total / peak) * 100)}%` }}
            />
          </div>
        );
      })}
    </div>
  );
}

export function SpendPanel(): ReactElement {
  const [days, setDays] = useState("30");
  const [data, setData] = useState<{
    models: ModelSpend[];
    byDay: { day: string; inputTokens: number; outputTokens: number }[];
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

          <Trend days={data?.byDay ?? []} />

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
                    {m.cost === undefined ? (
                      <span className="hint">no rate set</span>
                    ) : (
                      money(m.cost)
                    )}
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
