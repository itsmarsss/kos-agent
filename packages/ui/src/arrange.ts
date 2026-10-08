import type { HomePanel, WidgetSpan } from "@kos/shared";

/**
 * The arithmetic behind arranging the home page by hand.
 *
 * Kept apart from the pointer handling so the rules can be tested without a
 * DOM: where a dropped panel lands, which width a dragged edge snaps to.
 */

const SPANS: { span: WidgetSpan; fraction: number }[] = [
  { span: "quarter", fraction: 1 / 4 },
  { span: "third", fraction: 1 / 3 },
  { span: "half", fraction: 1 / 2 },
  { span: "full", fraction: 1 },
];

/** The width a panel snaps to when its edge is dragged to this share of the grid. */
export function spanFor(fraction: number): WidgetSpan {
  let best = SPANS[0]!;
  for (const s of SPANS) {
    if (Math.abs(s.fraction - fraction) < Math.abs(best.fraction - fraction)) best = s;
  }
  return best.span;
}

/** The list with one item moved to another position. */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item as T);
  return out;
}

/** The panels with one of them at the slot another occupies. */
export function moveTo(panels: HomePanel[], id: string, targetId: string): HomePanel[] {
  return moveItem(
    panels,
    panels.findIndex((p) => p.id === id),
    panels.findIndex((p) => p.id === targetId),
  );
}

export function withSpan(panels: HomePanel[], id: string, span: WidgetSpan): HomePanel[] {
  return panels.map((p) => (p.id === id && p.span !== span ? { ...p, span } : p));
}

/** Where a cell sits in the grid, in the grid's own coordinates. */
export interface Box {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The cell under a point, if any. */
export function hitBox(boxes: Box[], x: number, y: number): Box | undefined {
  return boxes.find(
    (b) => x >= b.left && x < b.left + b.width && y >= b.top && y < b.top + b.height,
  );
}
