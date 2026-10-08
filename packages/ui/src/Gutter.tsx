import { useRef, useState, type ReactElement } from "react";

/**
 * A drag handle between two columns.
 *
 * It sits in the gap and reports a new width for the column it belongs to
 * as the pointer moves; the page sets the width and remembers it. Arrow
 * keys move it too, and a double-click puts the column back to its default.
 */
export interface GutterProps {
  /** What is being resized, for the screen reader. */
  label: string;
  value: number;
  min: number;
  max: number;
  fallback: number;
  /**
   * Which way the column grows. A column on the left of the handle grows as
   * the handle moves right; one on the right grows as it moves left.
   */
  grows: "right" | "left";
  /** Every move, while dragging. */
  onChange: (width: number) => void;
  /** Once, when the drag ends or a key or double-click settles it. */
  onDone: (width: number) => void;
  /**
   * Dragged a little past the narrowest the column goes: the owner is
   * pushing it away, so it folds shut rather than sticking at its minimum.
   * The drag goes on, so dragging back out unfolds it again; released
   * folded, the width it had is kept for when it comes back.
   */
  onCollapse?: () => void;
  onExpand?: () => void;
  /**
   * The column is shut. The handle then sits at the edge it folded to, and
   * a drag from there grows the column from nothing: once it is pulled out
   * past the minimum it opens, at the width under the pointer.
   */
  collapsed?: boolean;
  className?: string;
}

const STEP = 16;
/** How far past the minimum the pointer goes before the column folds. */
const SNAP = 24;
/** And how far back before it unfolds, so a hand resting on the line does not flap it. */
const UNSNAP = 12;

export function Gutter({ label, value, min, max, fallback, grows, onChange, onDone, onCollapse, onExpand, collapsed = false, className }: GutterProps): ReactElement {
  const [active, setActive] = useState(false);
  /** Where the drag began: the pointer, the width it moves from, and the width to keep if it ends folded. */
  const start = useRef<{ x: number; width: number; keep: number } | null>(null);
  /** Folded right now, by this drag or from before it. */
  const folded = useRef(false);
  const clamp = (w: number): number => Math.min(max, Math.max(min, Math.round(w)));
  const sign = grows === "right" ? 1 : -1;

  return (
    <button
      type="button"
      className={`chats-gutter ${active ? "is-active" : ""} ${className ?? ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label}`}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      title="Drag to resize. Double-click to reset."
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        // Shut, the column grows from nothing; the remembered width is what
        // it keeps if the drag lets go before it is open.
        start.current = { x: e.clientX, width: collapsed ? 0 : value, keep: value };
        folded.current = collapsed;
        setActive(true);
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const raw = start.current.width + sign * (e.clientX - start.current.x);
        if (onCollapse && onExpand) {
          if (!folded.current && raw < min - SNAP) {
            folded.current = true;
            onCollapse();
            return;
          }
          if (folded.current) {
            if (raw < min - UNSNAP) return;
            folded.current = false;
            onExpand();
          }
        }
        onChange(clamp(raw));
      }}
      onPointerUp={(e) => {
        if (!start.current) return;
        // Released folded, the column keeps the width it had for when it opens.
        const width = folded.current ? start.current.keep : clamp(start.current.width + sign * (e.clientX - start.current.x));
        start.current = null;
        folded.current = false;
        setActive(false);
        onChange(width);
        onDone(width);
      }}
      onPointerCancel={() => {
        const width = start.current?.keep ?? value;
        start.current = null;
        folded.current = false;
        setActive(false);
        onChange(width);
        onDone(width);
      }}
      onDoubleClick={() => {
        onChange(fallback);
        onDone(fallback);
      }}
      onKeyDown={(e) => {
        const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (dir === 0) return;
        e.preventDefault();
        const width = clamp(value + sign * dir * STEP);
        onChange(width);
        onDone(width);
      }}
    />
  );
}
