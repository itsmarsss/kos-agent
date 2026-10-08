import type { ReactElement } from "react";

import type { ModuleInfo, Project, ProjectNode, UpcomingRun } from "./api.js";
import { clip, clockLabel, hourLabel } from "./chartdata.js";
import { hrefFor } from "./routes.js";

/**
 * The small charts the home page draws.
 *
 * Bars, strips and shares are HTML rather than SVG: they are made of boxes,
 * and boxes in a flex row scale with the panel, take the theme's colours and
 * need no axis maths. The map is SVG because it has lines between things.
 *
 * Every chart carries its numbers in `title`s, so a reader who wants the
 * figure behind a bar can hover for it rather than being given only a shape.
 */

export type Tone = "accent" | "ok" | "warn" | "danger" | "muted";

export interface Bar {
  label: string;
  title: string;
  parts: { value: number; tone: Tone }[];
}

/** Columns scaled to the tallest, stacked where a column has several parts. */
export function Bars({
  bars,
  labelEvery = 1,
  height = 56,
}: {
  bars: Bar[];
  /** Label every nth column, so twenty-four hours do not print twenty-four times. */
  labelEvery?: number;
  height?: number;
}): ReactElement {
  const sum = (b: Bar): number => b.parts.reduce((n, p) => n + p.value, 0);
  const peak = Math.max(1, ...bars.map(sum));
  return (
    <div className="chart">
      <div className="chart-bars" style={{ height }}>
        {bars.map((b, i) => (
          <div
            key={i}
            className={`chart-col${sum(b) === 0 ? " is-empty" : ""}`}
            title={b.title}
          >
            {b.parts.map(
              (p, j) =>
                p.value > 0 && (
                  <div
                    key={j}
                    className={`chart-part chart-part--${p.tone}`}
                    style={{ height: `${(p.value / peak) * 100}%` }}
                  />
                ),
            )}
          </div>
        ))}
      </div>
      <div className="chart-labels">
        {bars.map((b, i) => (
          <span key={i} className="chart-label">
            {i % labelEvery === 0 ? b.label : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

export interface Tick {
  tone: Tone;
  title: string;
}

/** A row of ticks, one per event, oldest on the left: the shape of a sequence. */
export function Ticks({ items }: { items: Tick[] }): ReactElement {
  return (
    <div className="chart-ticks">
      {items.map((t, i) => (
        <span key={i} className={`chart-tick chart-tick--${t.tone}`} title={t.title} />
      ))}
    </div>
  );
}

export interface Slice {
  label: string;
  value: number;
  tone: Tone;
}

/** One bar split by share, with a legend that carries the figures. */
export function Share({ parts }: { parts: Slice[] }): ReactElement | null {
  const total = parts.reduce((n, p) => n + p.value, 0);
  if (total <= 0) return null;
  const shown = parts.filter((p) => p.value > 0);
  return (
    <div className="chart-share">
      <div className="chart-share-bar">
        {shown.map((p) => (
          <span
            key={p.label}
            className={`chart-part--${p.tone}`}
            style={{ flex: p.value }}
            title={`${p.label}: ${Math.round((p.value / total) * 100)}%`}
          />
        ))}
      </div>
      <ul className="chart-legend">
        {shown.map((p) => (
          <li key={p.label}>
            <span className={`chart-dot chart-part--${p.tone}`} />
            <span className="chart-legend-label">{p.label}</span>
            <span className="chart-legend-value">{Math.round((p.value / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const DAY = 24 * 3_600_000;

/** The next day as a line, with a mark wherever a job is due. */
export function DayLine({ runs, now = Date.now() }: { runs: UpcomingRun[]; now?: number }): ReactElement {
  const marks = [0, 6, 12, 18, 24].map((h) => ({ at: h / 24, label: h === 0 ? "now" : hourLabel(now + h * 3_600_000) }));
  const due = runs.filter((r) => r.at >= now && r.at <= now + DAY);
  return (
    <div className="chart-dayline">
      <div className="chart-dayline-track">
        {marks.map((mk) => (
          <span key={mk.label} className="chart-dayline-mark" style={{ left: `${mk.at * 100}%` }} />
        ))}
        {due.map((r, i) => (
          <span
            key={`${r.id}-${i}`}
            className="chart-dayline-run"
            style={{ left: `${((r.at - now) / DAY) * 100}%` }}
            title={`${r.name} at ${clockLabel(r.at)}`}
          />
        ))}
      </div>
      <div className="chart-dayline-labels">
        {marks.map((mk) => (
          <span key={mk.label} style={{ left: `${mk.at * 100}%` }}>
            {mk.label}
          </span>
        ))}
      </div>
    </div>
  );
}

const MAP_W = 720;
const ROW = 46;
const PAD = 14;
const NODE_W = 220;
const MODULE_W = 190;
const MAX_NODES = 7;

type ModuleTone = "ok" | "warn" | "danger" | "muted" | "accent";

function moduleTone(mod: ModuleInfo): ModuleTone {
  if (mod.blueprint) return "accent";
  if (!mod.enabled) return "muted";
  if (mod.error) return "danger";
  return mod.connected ? "ok" : "warn";
}

function moduleState(mod: ModuleInfo): string {
  if (mod.blueprint) return `blueprint · ${mod.blueprint.instances.length} in use`;
  if (!mod.enabled) return "off";
  if (mod.error) return "not connected";
  return mod.tools ? `${mod.tools.length} tools` : "starting";
}

function projectTone(node: ProjectNode | undefined): Tone {
  if (!node) return "muted";
  if (node.needsYou > 0) return "warn";
  if (node.working > 0) return "accent";
  return "muted";
}

function projectState(node: ProjectNode | undefined): string {
  if (!node) return "nothing yet";
  const parts = [
    `${node.threads} ${node.threads === 1 ? "thread" : "threads"}`,
    ...(node.jobs ? [`${node.jobs} ${node.jobs === 1 ? "job" : "jobs"}`] : []),
    ...(node.needsYou ? [`${node.needsYou} waiting on you`] : node.working ? [`${node.working} working`] : []),
  ];
  return parts.join(" · ");
}

/** A curve from the hub's edge to a node's near edge. */
function link(x1: number, y1: number, x2: number, y2: number): string {
  const mid = (x1 + x2) / 2;
  return `M${x1} ${y1} C${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
}

/**
 * KOS in the middle, its modules on one side and its projects on the other.
 *
 * The question it answers is "what is KOS made of right now, and which of it
 * is doing something?" A list answers the first; the dots on the nodes
 * answer the second at a glance.
 */
export function ProjectMap({
  projects,
  nodes,
  modules,
  onModules,
}: {
  projects: Project[];
  nodes: ProjectNode[];
  modules: ModuleInfo[];
  onModules: () => void;
}): ReactElement {
  const byslug = new Map(nodes.map((n) => [n.slug, n]));
  const right = projects.slice(0, MAX_NODES);
  const left = modules.slice(0, MAX_NODES);
  const moreRight = projects.length - right.length;
  const moreLeft = modules.length - left.length;
  const rows = Math.max(1, right.length + (moreRight ? 1 : 0), left.length + (moreLeft ? 1 : 0));
  const H = rows * ROW + PAD * 2;
  const hub = { x: MAP_W / 2, y: H / 2, r: 30 };
  const yAt = (i: number, count: number): number => H / 2 + (i - (count - 1) / 2) * ROW;
  const leftCount = left.length + (moreLeft ? 1 : 0);
  const rightCount = right.length + (moreRight ? 1 : 0);
  const working = nodes.reduce((n, p) => n + p.working, 0);
  const waiting = nodes.reduce((n, p) => n + p.needsYou, 0);

  return (
    <svg
      className="map"
      viewBox={`0 0 ${MAP_W} ${H}`}
      width="100%"
      style={{ maxWidth: MAP_W, aspectRatio: `${MAP_W} / ${H}` }}
      role="img"
      aria-label="KOS, its modules and its projects"
    >
      {/* Links first, so nodes sit on top of them. */}
      {left.map((mod, i) => (
        <path
          key={`l-${mod.name}`}
          className={`map-link map-link--${moduleTone(mod)}`}
          d={link(hub.x - hub.r, hub.y, PAD + MODULE_W, yAt(i, leftCount))}
        />
      ))}
      {moreLeft > 0 && (
        <path className="map-link map-link--muted" d={link(hub.x - hub.r, hub.y, PAD + MODULE_W, yAt(left.length, leftCount))} />
      )}
      {right.map((p, i) => (
        <path
          key={`r-${p.slug}`}
          className={`map-link map-link--${projectTone(byslug.get(p.slug))}`}
          d={link(hub.x + hub.r, hub.y, MAP_W - PAD - NODE_W, yAt(i, rightCount))}
        />
      ))}
      {moreRight > 0 && (
        <path className="map-link map-link--muted" d={link(hub.x + hub.r, hub.y, MAP_W - PAD - NODE_W, yAt(right.length, rightCount))} />
      )}

      <g className="map-hub">
        <circle cx={hub.x} cy={hub.y} r={hub.r} />
        <text x={hub.x} y={hub.y + 1} textAnchor="middle" dominantBaseline="middle" className="map-hub-label">
          KOS
        </text>
        <text x={hub.x} y={hub.y + hub.r + 14} textAnchor="middle" className="map-sub">
          {waiting ? `${waiting} waiting on you` : working ? `${working} working` : "quiet"}
        </text>
      </g>

      {left.map((mod, i) => {
        const y = yAt(i, leftCount) - 17;
        return (
          <g key={mod.name} className="map-node map-node--module" onClick={onModules} role="link" tabIndex={0}>
            <rect x={PAD} y={y} width={MODULE_W} height={34} rx={8} />
            <circle className={`map-dot map-dot--${moduleTone(mod)}`} cx={PAD + 14} cy={y + 17} r={4} />
            <text x={PAD + 26} y={y + 14} className="map-name">
              {clip(mod.name, 22)}
            </text>
            <text x={PAD + 26} y={y + 27} className="map-sub">
              {moduleState(mod)}
            </text>
          </g>
        );
      })}
      {moreLeft > 0 && (
        <g className="map-node map-node--more" onClick={onModules} role="link" tabIndex={0}>
          <rect x={PAD} y={yAt(left.length, leftCount) - 13} width={MODULE_W} height={26} rx={8} />
          <text x={PAD + MODULE_W / 2} y={yAt(left.length, leftCount) + 4} textAnchor="middle" className="map-sub">
            {`${moreLeft} more`}
          </text>
        </g>
      )}
      {left.length === 0 && (
        <g className="map-node map-node--empty" onClick={onModules} role="link" tabIndex={0}>
          <rect x={PAD} y={hub.y - 13} width={MODULE_W} height={26} rx={8} />
          <text x={PAD + MODULE_W / 2} y={hub.y + 4} textAnchor="middle" className="map-sub">
            no modules
          </text>
        </g>
      )}

      {right.map((p, i) => {
        const y = yAt(i, rightCount) - 19;
        const x = MAP_W - PAD - NODE_W;
        const node = byslug.get(p.slug);
        return (
          <a key={p.slug} href={hrefFor({ name: "project", slug: p.slug })} className="map-node">
            <rect x={x} y={y} width={NODE_W} height={38} rx={8} />
            <circle className={`map-dot map-dot--${projectTone(node)}`} cx={x + 14} cy={y + 19} r={4} />
            <text x={x + 26} y={y + 16} className="map-name">
              {clip(p.name, 26)}
            </text>
            <text x={x + 26} y={y + 29} className="map-sub">
              {projectState(node)}
            </text>
          </a>
        );
      })}
      {moreRight > 0 && (
        <a href={hrefFor({ name: "projects" })} className="map-node map-node--more">
          <rect x={MAP_W - PAD - NODE_W} y={yAt(right.length, rightCount) - 13} width={NODE_W} height={26} rx={8} />
          <text x={MAP_W - PAD - NODE_W / 2} y={yAt(right.length, rightCount) + 4} textAnchor="middle" className="map-sub">
            {`${moreRight} more`}
          </text>
        </a>
      )}
      {right.length === 0 && (
        <a href={hrefFor({ name: "projects" })} className="map-node map-node--empty">
          <rect x={MAP_W - PAD - NODE_W} y={hub.y - 13} width={NODE_W} height={26} rx={8} />
          <text x={MAP_W - PAD - NODE_W / 2} y={hub.y + 4} textAnchor="middle" className="map-sub">
            no projects yet
          </text>
        </a>
      )}
    </svg>
  );
}
