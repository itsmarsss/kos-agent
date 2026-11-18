import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactElement, type RefObject } from "react";

/**
 * The list's columns, sized as Finder sizes them: Name takes whatever the
 * others leave, and each other column is as wide as its owner drags it, by
 * the divider on its left edge. A double-click on a divider fits the column
 * to what it holds; a focused divider moves with the arrow keys, Shift for
 * bigger steps, and Enter fits. The widths are kept per browser, one set
 * for each place a Finder is drawn (the Files page, a panel beside a chat).
 *
 * A column's track is minmax(its least, its width): in a Finder narrower
 * than the widths, the other columns give way before Name goes under its
 * least, so a width kept on a wide window never crowds a narrow one.
 */

export interface ColumnSpec {
  key: string;
  label: string;
  /** Its width, in px, until the owner changes it. */
  width: number;
  /** As narrow as it goes. */
  min: number;
}

export type ColumnWidths = Record<string, number>;

/** Name never goes narrower than this: the others stop growing first. */
export const NAME_MIN = 176;
/** No column grows past this, however far it is dragged. */
export const COLUMN_MAX = 480;
/** A press of an arrow on a divider; Shift moves four times as far. */
export const KEY_STEP = 8;

export const LIST_COLUMNS: readonly ColumnSpec[] = [
  { key: "modified", label: "Date Modified", width: 184, min: 96 },
  { key: "size", label: "Size", width: 88, min: 56 },
  { key: "kind", label: "Kind", width: 152, min: 72 },
];

export const TRASH_COLUMNS: readonly ColumnSpec[] = [
  { key: "trashed", label: "Date Trashed", width: 184, min: 96 },
  { key: "size", label: "Size", width: 88, min: 56 },
];

/** The Files page's list, a panel's beside a chat (narrower, so kept apart), and the trash. */
export const LIST_WIDTHS_KEY = "kos.finder.columns";
export const PANEL_WIDTHS_KEY = "kos.finder.panelColumns";
export const TRASH_WIDTHS_KEY = "kos.finder.trashColumns";

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

/** The grid's columns: Name flexible, each other column between its least and its width, then any fixed tail (the trash's actions). */
export const columnsTemplate = (specs: readonly ColumnSpec[], widths: ColumnWidths, tail = ""): string =>
  [`minmax(${NAME_MIN}px, 1fr)`, ...specs.map((s) => `minmax(${s.min}px, ${widths[s.key] ?? s.width}px)`), ...(tail ? [tail] : [])].join(" ");

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
  /** On the list's head row: where the dividers measure Name and the cells from. */
  headRef: RefObject<HTMLDivElement | null>;
  /** The divider for each column after Name, by key, to sit in that column's head. */
  divider: (key: string) => ReactElement | null;
}

/** A list's resizable columns: the widths, kept under `storeKey`, and the dividers that change them. */
export function useColumns(storeKey: string, specs: readonly ColumnSpec[], tail = ""): Columns {
  const [widths, setWidths] = useState<ColumnWidths>(() => readWidths(storeKey, specs));
  const headRef = useRef<HTMLDivElement>(null);
  const kept = useRef(widths);
  kept.current = widths;

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
      headRef.current?.parentElement?.style.setProperty("--finder-cols", columnsTemplate(specs, { ...kept.current, [key]: width }, tail));
    },
    [specs, tail],
  );

  /** A column's head, and how wide it is drawn now (narrower than its width in a narrow Finder). */
  const headOf = useCallback((key: string): HTMLElement | null => headRef.current?.querySelector<HTMLElement>(`[data-head="${key}"]`) ?? null, []);
  const drawn = useCallback((key: string): number => {
    const w = headOf(key)?.getBoundingClientRect().width ?? 0;
    const stored = kept.current[key] ?? 0;
    return w > 0 ? Math.min(stored, Math.round(w)) : stored;
  }, [headOf]);

  /** As wide as a column may go now: as far as Name can give without going under its least. Unbounded where nothing is laid out (jsdom). */
  const maxOf = useCallback(
    (spec: ColumnSpec): number => {
      const name = headOf("name")?.getBoundingClientRect().width ?? 0;
      return name > 0 ? clampWidth(drawn(spec.key) + name - NAME_MIN, spec) : COLUMN_MAX;
    },
    [headOf, drawn],
  );

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

  // What a divider says it can reach follows the Finder's width.
  useLayoutEffect(() => {
    const head = headRef.current;
    if (!head) return;
    const mark = (): void => {
      for (const spec of specs) head.querySelector(`[data-divider="${spec.key}"]`)?.setAttribute("aria-valuemax", String(maxOf(spec)));
    };
    mark();
    if (typeof ResizeObserver !== "function") return;
    const watch = new ResizeObserver(mark);
    watch.observe(head);
    return () => watch.disconnect();
  }, [specs, widths, maxOf]);

  const divider = useCallback(
    (key: string): ReactElement | null => {
      const spec = specs.find((s) => s.key === key);
      if (!spec) return null;
      return <Divider key={key} spec={spec} width={widths[key] ?? spec.width} drawn={() => drawn(key)} max={() => maxOf(spec)} onPreview={(w) => preview(key, w)} onResize={(w) => commit(key, w)} onFit={() => fit(spec)} />;
    },
    [specs, widths, drawn, maxOf, preview, commit, fit],
  );

  const style = useMemo(() => ({ "--finder-cols": columnsTemplate(specs, widths, tail) }) as CSSProperties, [specs, widths, tail]);
  return { style, headRef, divider };
}

function Divider({ spec, width, drawn, max, onPreview, onResize, onFit }: { spec: ColumnSpec; width: number; drawn: () => number; max: () => number; onPreview: (width: number) => void; onResize: (width: number) => void; onFit: () => void }): ReactElement {
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
    drag.current = { x: e.clientX, width: drawn(), max: max() };
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
    onResize(clampWidth(drawn() + by, spec, max()));
  };

  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${spec.label}`}
      aria-valuenow={width}
      aria-valuemin={spec.min}
      aria-valuemax={COLUMN_MAX}
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
