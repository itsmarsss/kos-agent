import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactElement, type RefObject } from "react";

/**
 * The list's columns, sized as Finder sizes them: Name takes whatever the
 * others leave, and each other column is as wide as its owner drags it, by
 * the divider on its left edge. A double-click on a divider fits the column
 * to what it holds; a focused divider moves with the arrow keys, Shift for
 * bigger steps, and Enter fits. The widths are kept per browser, one set
 * for each place a Finder is drawn (the Files page, a panel beside a chat).
 *
 * A Finder too narrow for every column drops them by rank, Kind first,
 * then Date, then Size, so nothing overlaps and Name keeps its least; they
 * come back as the room does.
 */

export interface ColumnSpec {
  key: string;
  label: string;
  /** Its width, in px, until the owner changes it. */
  width: number;
  /** As narrow as it goes. */
  min: number;
  /** Kept longer than any column of a lower rank as the Finder narrows. */
  rank: number;
}

export type ColumnWidths = Record<string, number>;

/** Where a list is drawn: its columns, where their widths are kept, and any fixed tail (the trash's actions), in px. */
export interface ColumnLayout {
  storeKey: string;
  specs: readonly ColumnSpec[];
  tail?: number;
  /** Name's least while another column shows, its icon and padding included; NAME_MIN when not said. */
  nameMin?: number;
}

/** Name never goes narrower than this while another column shows: that column hides first. */
export const NAME_MIN = 160;
/**
 * The Files page's Name keeps more: at 160 its icon and padding left a name
 * about 100 px of text, "quart…n-001.csv", while Date, Size and Kind all
 * stayed. Kind, then Date, then Size go before Name is cut that far.
 */
export const FILES_NAME_MIN = 260;
/** No column grows past this, however far it is dragged. */
export const COLUMN_MAX = 480;
/** A press of an arrow on a divider; Shift moves four times as far. */
export const KEY_STEP = 8;

export const LIST_COLUMNS: readonly ColumnSpec[] = [
  { key: "modified", label: "Date modified", width: 184, min: 96, rank: 2 },
  { key: "size", label: "Size", width: 88, min: 56, rank: 3 },
  { key: "kind", label: "Kind", width: 152, min: 72, rank: 1 },
];

/** A panel beside a chat starts narrower: a short date, a short kind; Size as the page's, since "209 bytes" did not fit in 80. */
export const PANEL_COLUMNS: readonly ColumnSpec[] = [
  { key: "modified", label: "Date modified", width: 140, min: 96, rank: 2 },
  { key: "size", label: "Size", width: 88, min: 56, rank: 3 },
  { key: "kind", label: "Kind", width: 108, min: 72, rank: 1 },
];

export const TRASH_COLUMNS: readonly ColumnSpec[] = [
  { key: "trashed", label: "Date trashed", width: 184, min: 96, rank: 1 },
  { key: "size", label: "Size", width: 88, min: 56, rank: 2 },
];

/** The Files page's list, a panel's beside a chat (narrower, so kept apart), and the trash. */
export const LIST_WIDTHS_KEY = "kos.finder.columns";
export const PANEL_WIDTHS_KEY = "kos.finder.panelColumns";
export const TRASH_WIDTHS_KEY = "kos.finder.trashColumns";

export const FILES_LAYOUT: ColumnLayout = { storeKey: LIST_WIDTHS_KEY, specs: LIST_COLUMNS, nameMin: FILES_NAME_MIN };
export const PANEL_LAYOUT: ColumnLayout = { storeKey: PANEL_WIDTHS_KEY, specs: PANEL_COLUMNS };
export const TRASH_LAYOUT: ColumnLayout = { storeKey: TRASH_WIDTHS_KEY, specs: TRASH_COLUMNS, tail: 240 };

export const clampWidth = (width: number, spec: ColumnSpec, max = COLUMN_MAX): number => Math.round(Math.min(Math.max(width, spec.min), Math.max(spec.min, Math.min(max, COLUMN_MAX))));

const defaults = (specs: readonly ColumnSpec[]): ColumnWidths => Object.fromEntries(specs.map((s) => [s.key, s.width]));

/** The widths this browser keeps, each held to its column's bounds; the defaults for any it has not kept or cannot read. */
export function readWidths(storeKey: string, specs: readonly ColumnSpec[]): ColumnWidths {
  const widths = defaults(specs);
  try {
    const kept = JSON.parse(localStorage.getItem(storeKey) ?? "null") as unknown;
    if (!kept || typeof kept !== "object") return widths;
    for (const spec of specs) {
      const w = (kept as Record<string, unknown>)[spec.key];
      if (typeof w === "number" && Number.isFinite(w)) widths[spec.key] = clampWidth(w, spec);
    }
  } catch {
    // Nothing kept, or a browser that keeps nothing: the defaults.
  }
  return widths;
}

export function saveWidths(storeKey: string, widths: ColumnWidths): void {
  try {
    localStorage.setItem(storeKey, JSON.stringify(widths));
  } catch {
    // Kept for this visit only.
  }
}

/**
 * Which columns show in a list `room` px wide, in their order: by rank,
 * highest first, each while Name keeps its least beside them, and none of a
 * lower rank once one does not fit. Every column where nothing is laid out
 * (room 0, as in jsdom).
 */
export function fitColumns(room: number, specs: readonly ColumnSpec[], widths: ColumnWidths, tail = 0, nameMin = NAME_MIN): string[] {
  if (room <= 0) return specs.map((s) => s.key);
  let used = nameMin + tail;
  const shown = new Set<string>();
  for (const spec of [...specs].sort((a, b) => b.rank - a.rank)) {
    const width = widths[spec.key] ?? spec.width;
    if (used + width > room) break;
    used += width;
    shown.add(spec.key);
  }
  return specs.filter((s) => shown.has(s.key)).map((s) => s.key);
}

/** The grid's columns: Name takes the rest, each shown column its width, then any fixed tail. */
export const columnsTemplate = (shown: readonly ColumnSpec[], widths: ColumnWidths, tail = 0): string =>
  ["minmax(0, 1fr)", ...shown.map((s) => `${widths[s.key] ?? s.width}px`), ...(tail ? [`${tail}px`] : [])].join(" ");

/** As wide as a column may go in `room`: what Name and the other shown columns leave it. Unbounded where nothing is laid out. */
export function widestOf(spec: ColumnSpec, room: number, shown: readonly ColumnSpec[], widths: ColumnWidths, tail = 0, nameMin = NAME_MIN): number {
  if (room <= 0) return COLUMN_MAX;
  const others = shown.filter((s) => s.key !== spec.key).reduce((sum, s) => sum + (widths[s.key] ?? s.width), 0);
  return clampWidth(room - nameMin - tail - others, spec);
}

/** How wide a cell's contents are drawn, its padding included: a Range over them, since a cell that clips (overflow hidden) reports a scroll width no narrower than itself. */
export function contentWidth(cell: HTMLElement): number {
  const range = document.createRange();
  range.selectNodeContents(cell);
  const style = getComputedStyle(cell);
  return range.getBoundingClientRect().width + (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
}

export interface Columns {
  /** On the list: its grid, as `--finder-cols`. */
  style: CSSProperties;
  /** On the list's head row: its width is the room the columns fit in. */
  headRef: RefObject<HTMLDivElement | null>;
  /** The keys of the columns after Name that fit, in order: draw only these. */
  shown: string[];
  /** The divider for a shown column after Name, by key, to sit in that column's head. */
  divider: (key: string) => ReactElement | null;
}

/** A list's resizable columns: the widths, kept under the layout's key, which of them fit, and the dividers that change them. */
export function useColumns({ storeKey, specs, tail = 0, nameMin = NAME_MIN }: ColumnLayout): Columns {
  const [widths, setWidths] = useState<ColumnWidths>(() => readWidths(storeKey, specs));
  const [room, setRoom] = useState(0);
  const headRef = useRef<HTMLDivElement>(null);
  const kept = useRef(widths);
  kept.current = widths;

  useLayoutEffect(() => {
    const head = headRef.current;
    if (!head || typeof ResizeObserver !== "function") return undefined;
    const watch = new ResizeObserver(([seen]) => setRoom(Math.floor(seen?.contentRect.width ?? 0)));
    watch.observe(head);
    return () => watch.disconnect();
  }, []);

  const shownKeys = useMemo(() => fitColumns(room, specs, widths, tail, nameMin), [room, specs, widths, tail, nameMin]);
  const shown = useMemo(() => specs.filter((s) => shownKeys.includes(s.key)), [specs, shownKeys]);

  const commit = useCallback(
    (key: string, width: number): void => {
      const next = { ...kept.current, [key]: width };
      kept.current = next;
      setWidths(next);
      saveWidths(storeKey, next);
    },
    [storeKey],
  );

  /** Mid-drag the grid is set on the list itself, so the rows are not drawn again for every move; let go, the width is kept. */
  const preview = useCallback(
    (key: string, width: number): void => {
      headRef.current?.parentElement?.style.setProperty("--finder-cols", columnsTemplate(shown, { ...kept.current, [key]: width }, tail));
    },
    [shown, tail],
  );

  const maxOf = useCallback((spec: ColumnSpec): number => widestOf(spec, room, shown, kept.current, tail, nameMin), [room, shown, tail, nameMin]);

  /** As wide as the widest thing in the column, its head's words included: narrower or wider. */
  const fit = useCallback(
    (spec: ColumnSpec): void => {
      const list = headRef.current?.parentElement;
      if (!list) return;
      const widest = Math.max(0, ...[...list.querySelectorAll<HTMLElement>(`[data-col="${spec.key}"]`)].map(contentWidth));
      commit(spec.key, clampWidth(Math.ceil(widest) + 1, spec, maxOf(spec)));
    },
    [commit, maxOf],
  );

  const divider = useCallback(
    (key: string): ReactElement | null => {
      const spec = shown.find((s) => s.key === key);
      if (!spec) return null;
      const width = widths[key] ?? spec.width;
      return <Divider key={key} spec={spec} width={width} max={maxOf(spec)} onPreview={(w) => preview(key, w)} onResize={(w) => commit(key, w)} onFit={() => fit(spec)} />;
    },
    [shown, widths, maxOf, preview, commit, fit],
  );

  const style = useMemo(() => ({ "--finder-cols": columnsTemplate(shown, widths, tail) }) as CSSProperties, [shown, widths, tail]);
  return { style, headRef, shown: shownKeys, divider };
}

function Divider({ spec, width, max, onPreview, onResize, onFit }: { spec: ColumnSpec; width: number; max: number; onPreview: (width: number) => void; onResize: (width: number) => void; onFit: () => void }): ReactElement {
  const drag = useRef<{ x: number; width: number; max: number } | null>(null);
  const at = (e: PointerEvent<HTMLSpanElement>): number => {
    const d = drag.current!;
    // The divider is the column's left edge: dragged left, the column grows.
    return clampWidth(d.width + d.x - e.clientX, spec, d.max);
  };

  const down = (e: PointerEvent<HTMLSpanElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.currentTarget.classList.add("is-dragging");
    drag.current = { x: e.clientX, width, max };
  };
  const move = (e: PointerEvent<HTMLSpanElement>): void => {
    if (drag.current) onPreview(at(e));
  };
  const up = (e: PointerEvent<HTMLSpanElement>): void => {
    if (!drag.current) return;
    const w = at(e);
    drag.current = null;
    e.currentTarget.classList.remove("is-dragging");
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    onResize(w);
  };
  const key = (e: KeyboardEvent<HTMLSpanElement>): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      onFit();
      return;
    }
    const step = (e.shiftKey ? 4 : 1) * KEY_STEP;
    const by = e.key === "ArrowLeft" ? step : e.key === "ArrowRight" ? -step : 0;
    if (!by) return;
    e.preventDefault();
    onResize(clampWidth(width + by, spec, max));
  };

  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${spec.label}`}
      aria-valuenow={width}
      aria-valuemin={spec.min}
      aria-valuemax={max}
      data-divider={spec.key}
      tabIndex={0}
      className="finder-divider"
      title="Drag to resize, double-click to fit"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onFit();
      }}
      onKeyDown={key}
    />
  );
}
