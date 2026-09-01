import type { ChartWidget } from "@kos/shared";
import type { ReactElement } from "react";

import { formatCell, formatNumber, humanize, toNumber, truncate } from "./format.js";
import type { Row, WidgetProps } from "./types.js";

/**
 * Charts as inline SVG: no charting library, no runtime dependency, nothing
 * loaded cross-origin. Colors come from the --chart-* theme tokens so the same
 * markup stays legible in either theme, and every chart ships a table twin so no
 * value is reachable only by hovering.
 *
 * Data convention: the first non-numeric column labels the x axis, every numeric
 * column after it is a series. Pie takes the first numeric column only.
 */

/** Categorical slots are assigned in fixed order and never cycled. */
const MAX_SERIES = 6;
const MAX_SLICES = 6;

const W = 640;
const H = 220;
const PAD = { top: 14, right: 62, bottom: 30, left: 56 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

const PIE_SIZE = 220;
const PIE_R = 92;

interface Series {
  name: string;
  color: string;
  values: (number | null)[];
}

interface ChartData {
  labels: string[];
  series: Series[];
  /** Series dropped past the slot cap; they stay in the table twin. */
  dropped: number;
}

function slot(index: number): string {
  return `var(--chart-${index + 1})`;
}

function readData(rows: Row[]): ChartData {
  const first = rows[0];
  if (!first) return { labels: [], series: [], dropped: 0 };
  const columns = Object.keys(first);

  const numeric = columns.filter((c) =>
    rows.some((r) => toNumber(r[c]) !== null) &&
    rows.every((r) => r[c] === null || r[c] === undefined || toNumber(r[c]) !== null),
  );
  const labelColumn = columns.find((c) => !numeric.includes(c));

  const labels = rows.map((r, i) =>
    labelColumn ? formatCell(r[labelColumn], labelColumn) : String(i + 1),
  );
  const seriesColumns = numeric.filter((c) => c !== labelColumn);
  const kept = seriesColumns.slice(0, MAX_SERIES);

  return {
    labels,
    series: kept.map((c, i) => ({
      name: humanize(c),
      color: slot(i),
      values: rows.map((r) => toNumber(r[c])),
    })),
    dropped: seriesColumns.length - kept.length,
  };
}

/** Round a domain out to clean tick numbers (0 / 1,000 / 2,000). */
function niceTicks(min: number, max: number, count = 4): number[] {
  const lo = Math.min(0, min);
  const hi = max > lo ? max : lo + 1;
  const raw = (hi - lo) / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / magnitude;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * magnitude;
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) {
    ticks.push(Number(v.toPrecision(12)));
  }
  return ticks.length > 1 ? ticks : [0, 1];
}

function bandCenter(index: number, count: number): number {
  const band = PLOT_W / Math.max(count, 1);
  return PAD.left + band * (index + 0.5);
}

/** Show every nth x label so ticks never collide. */
function labelStride(count: number): number {
  return Math.max(1, Math.ceil(count / 9));
}

function Axes({
  ticks,
  y,
  labels,
}: {
  ticks: number[];
  y: (v: number) => number;
  labels: string[];
}): ReactElement {
  const stride = labelStride(labels.length);
  const zero = ticks.includes(0) ? 0 : ticks[0];
  return (
    <g aria-hidden="true">
      {ticks.map((t) => (
        <g key={t}>
          <line
            x1={PAD.left}
            x2={PAD.left + PLOT_W}
            y1={y(t)}
            y2={y(t)}
            className={t === zero ? "kos-chart-axis" : "kos-chart-grid"}
          />
          <text x={PAD.left - 8} y={y(t) + 3} className="kos-chart-tick" textAnchor="end">
            {formatNumber(t)}
          </text>
        </g>
      ))}
      {labels.map((label, i) =>
        i % stride === 0 ? (
          <text
            key={i}
            x={bandCenter(i, labels.length)}
            y={PAD.top + PLOT_H + 16}
            className="kos-chart-tick"
            textAnchor="middle"
          >
            {truncate(label, 12)}
          </text>
        ) : null,
      )}
    </g>
  );
}

function linePath(points: Array<{ x: number; y: number } | null>): string {
  let d = "";
  let open = false;
  for (const p of points) {
    if (!p) {
      open = false;
      continue;
    }
    d += `${open ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)} `;
    open = true;
  }
  return d.trim();
}

function LineChart({
  data,
  filled,
}: {
  data: ChartData;
  filled: boolean;
}): ReactElement {
  const all = data.series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const ticks = niceTicks(Math.min(...all, 0), Math.max(...all, 0));
  const lo = ticks[0] ?? 0;
  const hi = ticks[ticks.length - 1] ?? 1;
  const y = (v: number): number =>
    PAD.top + PLOT_H - ((v - lo) / (hi - lo || 1)) * PLOT_H;
  const labelEnds = data.series.length <= 3;

  return (
    <>
      <Axes ticks={ticks} y={y} labels={data.labels} />
      {data.series.map((s) => {
        const points = s.values.map((v, i) =>
          v === null ? null : { x: bandCenter(i, data.labels.length), y: y(v) },
        );
        const drawn = points.filter((p): p is { x: number; y: number } => p !== null);
        const last = drawn[drawn.length - 1];
        const first = drawn[0];
        const area =
          filled && first && last
            ? `${linePath(points)} L${last.x.toFixed(1)},${y(lo).toFixed(1)} L${first.x.toFixed(1)},${y(lo).toFixed(1)} Z`
            : "";
        const endValue = [...s.values].reverse().find((v): v is number => v !== null);
        return (
          <g key={s.name}>
            {area ? <path d={area} fill={s.color} className="kos-chart-area" /> : null}
            <path d={linePath(points)} fill="none" stroke={s.color} className="kos-chart-line" />
            {last ? (
              <circle cx={last.x} cy={last.y} r={4} fill={s.color} className="kos-chart-dot" />
            ) : null}
            {labelEnds && last && endValue !== undefined ? (
              <text x={last.x + 9} y={last.y + 3} className="kos-chart-value" textAnchor="start">
                {formatNumber(endValue)}
              </text>
            ) : null}
            {points.map((p, i) =>
              p ? (
                <circle key={i} cx={p.x} cy={p.y} r={12} className="kos-chart-hit">
                  <title>{`${data.labels[i] ?? ""} · ${s.name}: ${formatNumber(s.values[i] ?? 0)}`}</title>
                </circle>
              ) : null,
            )}
          </g>
        );
      })}
    </>
  );
}

/** A bar with a 4px rounded data end and a square foot on the baseline. */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.max(0, Math.min(4, w / 2, Math.abs(h)));
  if (h >= 0) {
    return `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`;
  }
  const bottom = y + h;
  return `M${x},${y} L${x},${bottom - r} Q${x},${bottom} ${x + r},${bottom} L${x + w - r},${bottom} Q${x + w},${bottom} ${x + w},${bottom - r} L${x + w},${y} Z`;
}

function BarChart({ data }: { data: ChartData }): ReactElement {
  const all = data.series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const ticks = niceTicks(Math.min(...all, 0), Math.max(...all, 0));
  const lo = ticks[0] ?? 0;
  const hi = ticks[ticks.length - 1] ?? 1;
  const y = (v: number): number =>
    PAD.top + PLOT_H - ((v - lo) / (hi - lo || 1)) * PLOT_H;
  const baseline = y(Math.max(lo, 0));

  const band = PLOT_W / Math.max(data.labels.length, 1);
  const group = band * 0.7;
  const count = Math.max(data.series.length, 1);
  // 2px of surface between neighbours does the separating, never a stroke.
  const barW = Math.max(1, Math.min(24, group / count - 2));
  const capValues = data.series.length === 1 && data.labels.length <= 8;

  return (
    <>
      <Axes ticks={ticks} y={y} labels={data.labels} />
      {data.series.map((s, si) =>
        s.values.map((v, i) => {
          if (v === null) return null;
          const center = bandCenter(i, data.labels.length);
          const x = center - (barW * count + 2 * (count - 1)) / 2 + si * (barW + 2);
          const top = y(v);
          return (
            <g key={`${s.name}-${i}`}>
              <path d={barPath(x, top, barW, baseline - top)} fill={s.color}>
                <title>{`${data.labels[i] ?? ""} · ${s.name}: ${formatNumber(v)}`}</title>
              </path>
              {capValues ? (
                <text
                  x={center}
                  y={Math.min(top, baseline) - 5}
                  className="kos-chart-value"
                  textAnchor="middle"
                >
                  {formatNumber(v)}
                </text>
              ) : null}
            </g>
          );
        }),
      )}
    </>
  );
}

interface Slice {
  name: string;
  value: number;
  color: string;
}

function slices(data: ChartData): Slice[] {
  const series = data.series[0];
  if (!series) return [];
  const raw = data.labels
    .map((name, i) => ({ name, value: series.values[i] ?? 0 }))
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value);
  const head = raw.slice(0, MAX_SLICES - 1);
  const tail = raw.slice(MAX_SLICES - 1);
  const folded =
    tail.length > 1
      ? [...head, { name: "Other", value: tail.reduce((sum, s) => sum + s.value, 0) }]
      : raw.slice(0, MAX_SLICES);
  return folded.map((s, i) => ({ ...s, color: slot(i) }));
}

function arc(cx: number, cy: number, r: number, from: number, to: number): string {
  const x1 = cx + r * Math.cos(from);
  const y1 = cy + r * Math.sin(from);
  const x2 = cx + r * Math.cos(to);
  const y2 = cy + r * Math.sin(to);
  const large = to - from > Math.PI ? 1 : 0;
  return `M${cx},${cy} L${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 ${large} 1 ${x2.toFixed(1)},${y2.toFixed(1)} Z`;
}

function PieChart({ data }: { data: ChartData }): ReactElement {
  const parts = slices(data);
  const total = parts.reduce((sum, s) => sum + s.value, 0);
  const cx = PIE_SIZE / 2;
  const cy = PIE_SIZE / 2;
  let angle = -Math.PI / 2;

  return (
    <>
      {parts.map((s) => {
        const sweep = total > 0 ? (s.value / total) * Math.PI * 2 : 0;
        const from = angle;
        const to = angle + sweep;
        angle = to;
        const share = total > 0 ? Math.round((s.value / total) * 100) : 0;
        return (
          // the 2px surface stroke is the gap between slices, not a border
          <path
            key={s.name}
            d={arc(cx, cy, PIE_R, from, to)}
            fill={s.color}
            className="kos-chart-slice"
          >
            <title>{`${s.name}: ${formatNumber(s.value)} (${share}%)`}</title>
          </path>
        );
      })}
    </>
  );
}

interface LegendItem {
  name: string;
  color: string;
  /** Optional value text; identity stays with the swatch, never colored text. */
  note?: string;
}

function Legend({ items, line }: { items: LegendItem[]; line: boolean }): ReactElement {
  return (
    <ul className="kos-chart-legend">
      {items.map((item) => (
        <li key={item.name}>
          <span
            className={line ? "kos-chart-key kos-chart-key--line" : "kos-chart-key"}
            style={{ background: item.color }}
          />
          {item.name}
          {item.note ? <span className="kos-chart-legend-note">{item.note}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** Pie values live in the legend, so no label has to fit inside a slice. */
function pieLegend(parts: Slice[]): LegendItem[] {
  const total = parts.reduce((sum, s) => sum + s.value, 0);
  return parts.map((s) => ({
    name: s.name,
    color: s.color,
    note: `${formatNumber(s.value)} · ${total > 0 ? Math.round((s.value / total) * 100) : 0}%`,
  }));
}

/** The table twin: every plotted value reachable without hovering. */
function DataTable({ rows }: { rows: Row[] }): ReactElement | null {
  const first = rows[0];
  if (!first) return null;
  const columns = Object.keys(first);
  return (
    <details className="kos-chart-data">
      <summary>Data table</summary>
      <table className="kos-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c}>{humanize(c)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c}>{formatCell(r[c], c)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

export function Chart({ widget, rows }: WidgetProps): ReactElement {
  const w = widget as ChartWidget;
  const data = readData(rows);
  const label = w.title ?? `${w.kind} chart`;

  if (data.series.length === 0) {
    return (
      <div className="kos-widget kos-chart">
        {w.title ? <div className="kos-widget-title">{w.title}</div> : null}
        <div className="kos-empty">no chart data</div>
      </div>
    );
  }

  const pie = w.kind === "pie";
  const parts = pie ? slices(data) : [];

  return (
    <div className="kos-widget kos-chart">
      {w.title ? <div className="kos-widget-title">{w.title}</div> : null}
      <div className={pie ? "kos-chart-body kos-chart-body--pie" : "kos-chart-body"}>
        <svg
          className="kos-chart-svg"
          viewBox={pie ? `0 0 ${PIE_SIZE} ${PIE_SIZE}` : `0 0 ${W} ${H}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={label}
          data-kind={w.kind}
        >
          {w.kind === "pie" ? (
            <PieChart data={data} />
          ) : w.kind === "bar" ? (
            <BarChart data={data} />
          ) : (
            <LineChart data={data} filled={w.kind === "area"} />
          )}
        </svg>
        {pie ? <Legend items={pieLegend(parts)} line={false} /> : null}
      </div>
      {!pie && data.series.length > 1 ? (
        <Legend items={data.series} line={w.kind === "line"} />
      ) : null}
      {data.dropped > 0 ? (
        <div className="kos-note">{data.dropped} more series in the table</div>
      ) : null}
      <DataTable rows={rows} />
    </div>
  );
}
