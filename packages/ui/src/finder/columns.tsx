import { useCallback, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactElement, type RefObject } from "react";

/**
 * The list's columns, sized as Finder sizes them: Name takes whatever the
 * others leave, and each other column is as wide as its owner drags it, by
 * the divider on its left edge. A double-click on a divider fits the column
 * to what it holds; a focused divider moves with the arrow keys, Shift for
 * bigger steps, and Enter fits. The widths are kept per browser.
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

export const LIST_WIDTHS_KEY = "kos.finder.columns";
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

/** The grid's columns: Name flexible, the others at their widths, then any fixed tail (the trash's actions). */
export const columnsTemplate = (specs: readonly ColumnSpec[], widths: ColumnWidths, tail = ""): string =>
  [`minmax(${NAME_MIN}px, 1fr)`, ...specs.map((s) => `${widths[s.key] ?? s.width}px`), ...(tail ? [tail] : [])].join(" ");

export interface Columns {
  widths: ColumnWidths;
  /** On the list: its grid, as `--finder-cols`. */
  style: CSSProperties;
  /** On the list's head row: where the dividers measure Name and the cells from. */
  headRef: RefObject<HTMLDivElement | null>;
  /** The dividers, one at the left edge of each column after Name. */
  dividers: ReactElement[];
}

/** A list's resizable columns: the widths, kept under `storeKey`, and the dividers that change them. */
export function useColumns(storeKey: string, specs: readonly ColumnSpec[], tail = ""): Columns {
  const [widths, setWidths] = useState<ColumnWidths>(() => readWidths(storeKey, specs));
  const headRef = useRef<HTMLDivElement>(null);
  const kept = useRef(widths);
  kept.current = widths;

  const set = useCallback(
    (key: string, width: number, save: boolean): void => {
      const next = { ...kept.current, [key]: width };
      kept.current = next;
      setWidths(next);
      if (save) saveWidths(storeKey, next);
    },
    [storeKey],
  );

  /** How far a column may grow before Name would go under its least: unbounded where nothing is laid out (a test). */
  const room = useCallback((): number => {
    const name = headRef.current?.querySelector<HTMLElement>('[data-col="name"]')?.getBoundingClientRect().width ?? 0;
    return name > 0 ? Math.max(0, name - NAME_MIN) : Number.POSITIVE_INFINITY;
  }, []);

  /** As wide as the widest thing in the column, its head included. */
  const fit = useCallback(
    (spec: ColumnSpec): void => {
      const list = headRef.current?.parentElement;
      if (!list) return;
      const cells = [...list.querySelectorAll<HTMLElement>(`[data-col="${spec.key}"]`)];
      const widest = Math.max(0, ...cells.map((c) => c.scrollWidth));
      const now = kept.current[spec.key] ?? spec.width;
      set(spec.key, clampWidth(widest + 2, spec, now + room()), true);
    },
    [room, set],
  );

  const dividers = useMemo(
    () =>
      specs.map((spec, i) => (
        <Divider
          key={spec.key}
          spec={spec}
          column={i + 2}
          width={widths[spec.key] ?? spec.width}
          room={room}
          onResize={(w, save) => set(spec.key, w, save)}
          onFit={() => fit(spec)}
        />
      )),
    [specs, widths, room, set, fit],
  );

  const style = useMemo(() => ({ "--finder-cols": columnsTemplate(specs, widths, tail) }) as CSSProperties, [specs, widths, tail]);
  return { widths, style, headRef, dividers };
}

function Divider({ spec, column, width, room, onResize, onFit }: { spec: ColumnSpec; column: number; width: number; room: () => number; onResize: (width: number, save: boolean) => void; onFit: () => void }): ReactElement {
  const drag = useRef<{ x: number; width: number; max: number } | null>(null);

  const down = (e: PointerEvent<HTMLSpanElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, width, max: width + room() };
  };
  const move = (e: PointerEvent<HTMLSpanElement>): void => {
    const d = drag.current;
    if (!d) return;
    // The divider is the column's left edge: dragged left, the column grows.
    onResize(clampWidth(d.width + d.x - e.clientX, spec, d.max), false);
  };
  const up = (e: PointerEvent<HTMLSpanElement>): void => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    onResize(clampWidth(d.width + d.x - e.clientX, spec, d.max), true);
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
    onResize(clampWidth(width + by, spec, width + room()), true);
  };

  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${spec.label}`}
      aria-valuenow={width}
      aria-valuemin={spec.min}
      aria-valuemax={COLUMN_MAX}
      tabIndex={0}
      className={`finder-divider${drag.current ? " is-dragging" : ""}`}
      style={{ gridColumn: column }}
      title="Drag to resize, double-click to fit"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onFit();
      }}
      onKeyDown={key}
    />
  );
}
