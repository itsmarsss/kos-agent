import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";
import type { HomePanel, WidgetSpan } from "@kos/shared";

import { m } from "motion/react";

import { hitBox, moveTo, spanFor, withSpan, type Box } from "./arrange.js";
import { spring } from "./motion.js";

/**
 * The home page's grid, arranged by dragging.
 *
 * Pick a panel up and the others make room for it as you move; drag a
 * panel's edge and it snaps to the next width. Nothing to press, nothing to
 * choose from a menu: the arrangement is the thing you see.
 *
 * The lifted panel is a ghost drawn over the page at the pointer, while its
 * cell stays in the grid as a hole and travels with the layout animation.
 * That keeps the moving part and the reflowing part separate: the ghost
 * follows the hand exactly, and the grid animates as it would for any other
 * change.
 *
 * The pointer is followed on the window, not the cell. A reorder moves the
 * cell to a new place in the DOM, and a node moved in the DOM loses its
 * pointer capture, so a drag tracked on the cell lost its own drop the
 * moment it first made room.
 */

/** How far a press travels before it is a drag rather than a click. */
const LIFT_AFTER = 6;

/** How long the ghost takes to settle into its cell. */
const LANDING_MS = 160;

const WIDTHS: WidgetSpan[] = ["quarter", "third", "half", "full"];

/** Things a press on which is not the start of a drag. */
const INTERACTIVE = "button, a, input, textarea, select, [contenteditable], .home-grip";

interface Lift {
  id: string;
  /** Where the ghost is drawn before any movement: the cell's corner. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** The pointer when the panel was picked up. */
  x: number;
  y: number;
  content: ReactElement;
}

type Listeners = { move: (e: PointerEvent) => void; up: (e: PointerEvent) => void };

export function HomeGrid({
  panels,
  editing,
  render,
  onChange,
  onRemove,
}: {
  panels: HomePanel[];
  /** Arrange mode: every panel drags, edges resize, and each has a remove. */
  editing: boolean;
  render: (panel: HomePanel) => ReactElement;
  /** A new arrangement; `commit` says the hand has let go and it should be kept. */
  onChange: (panels: HomePanel[], commit: boolean) => void;
  onRemove: (id: string) => void;
}): ReactElement {
  const grid = useRef<HTMLDivElement>(null);
  const ghost = useRef<HTMLDivElement | null>(null);
  /** The arrangement as of the last change, ahead of the render that shows it. */
  const latest = useRef(panels);
  latest.current = panels;
  const lifted = useRef<Lift | null>(null);
  const pointer = useRef({ x: 0, y: 0 });
  const listening = useRef<Listeners | null>(null);
  const [lift, setLift] = useState<Lift | null>(null);

  useEffect(() => {
    document.body.classList.toggle("is-arranging", lift !== null);
    return () => document.body.classList.remove("is-arranging");
  }, [lift]);

  // A drag outlives nothing: leaving the page mid-drag drops the listeners.
  useEffect(() => () => unlisten(), []);

  const listen = (l: Listeners): void => {
    unlisten();
    listening.current = l;
    window.addEventListener("pointermove", l.move);
    window.addEventListener("pointerup", l.up);
    window.addEventListener("pointercancel", l.up);
  };

  const unlisten = (): void => {
    const l = listening.current;
    if (!l) return;
    listening.current = null;
    window.removeEventListener("pointermove", l.move);
    window.removeEventListener("pointerup", l.up);
    window.removeEventListener("pointercancel", l.up);
  };

  const change = (next: HomePanel[], commit: boolean): void => {
    latest.current = next;
    onChange(next, commit);
  };

  /** Where each cell will be once any layout animation lands. */
  const boxes = (): Box[] => {
    const el = grid.current;
    if (!el) return [];
    return Array.from(el.children)
      .filter((c): c is HTMLElement => c instanceof HTMLElement && !!c.dataset["id"])
      .map((c) => ({
        id: c.dataset["id"]!,
        left: c.offsetLeft,
        top: c.offsetTop,
        width: c.offsetWidth,
        height: c.offsetHeight,
      }));
  };

  const cellOf = (id: string): HTMLElement | null =>
    Array.from(grid.current?.children ?? []).find(
      (c): c is HTMLElement => c instanceof HTMLElement && c.dataset["id"] === id,
    ) ?? null;

  const ghostTransform = (): string => {
    const l = lifted.current;
    return l ? `translate(${pointer.current.x - l.x}px, ${pointer.current.y - l.y}px)` : "";
  };

  // Stable, so React attaches it once: an inline ref would run again on
  // every render and put the ghost back at its origin mid-carry.
  const ghostRef = useCallback((el: HTMLDivElement | null): void => {
    ghost.current = el;
    // Mounted after the first move, so it starts where the hand already is.
    if (el) el.style.transform = ghostTransform();
  }, []);

  const carry = (e: PointerEvent): void => {
    const l = lifted.current;
    if (!l) return;
    pointer.current = { x: e.clientX, y: e.clientY };
    if (ghost.current) ghost.current.style.transform = ghostTransform();
    const area = grid.current?.getBoundingClientRect();
    if (!area) return;
    const over = hitBox(boxes(), e.clientX - area.left, e.clientY - area.top);
    if (over && over.id !== l.id) change(moveTo(latest.current, l.id, over.id), false);
  };

  const drop = (): void => {
    unlisten();
    const l = lifted.current;
    if (!l) return;
    lifted.current = null;
    change(latest.current, true);
    // The ghost settles into the hole, then the real panel shows through.
    const cell = cellOf(l.id);
    const area = grid.current?.getBoundingClientRect();
    const g = ghost.current;
    if (cell && area && g && typeof g.animate === "function") {
      const x = area.left + cell.offsetLeft - l.left;
      const y = area.top + cell.offsetTop - l.top;
      const landing = g.animate(
        [{ transform: g.style.transform || "none" }, { transform: `translate(${x}px, ${y}px)` }],
        { duration: LANDING_MS, easing: "cubic-bezier(0.4, 0, 0.2, 1)", fill: "forwards" },
      );
      // The clock as well as the animation: a tab in the background keeps
      // its animations at zero, and a ghost must not outlive its drop.
      const settled = (): void => setLift(null);
      landing.onfinish = settled;
      landing.oncancel = settled;
      setTimeout(settled, LANDING_MS + 80);
    } else {
      setLift(null);
    }
  };

  const press = (panel: HomePanel) => (e: ReactPointerEvent<HTMLElement>): void => {
    if (e.button !== 0 || lifted.current) return;
    const target = e.target as HTMLElement;
    if (target.closest(INTERACTIVE)) return;
    // Outside Arrange, only the panel's head is a handle, so text in a
    // panel still selects and a row still scrolls.
    if (!editing && !target.closest(".panel-head")) return;
    // Otherwise the browser starts selecting text under the moving pointer.
    e.preventDefault();
    const cell = e.currentTarget;
    const start = { x: e.clientX, y: e.clientY };
    listen({
      move: (ev) => {
        if (lifted.current) {
          carry(ev);
          return;
        }
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < LIFT_AFTER) return;
        const rect = cell.getBoundingClientRect();
        const next: Lift = {
          id: panel.id,
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          x: ev.clientX,
          y: ev.clientY,
          content: render(panel),
        };
        lifted.current = next;
        setLift(next);
        // A quick flick is one move: the pick-up and the carry are the same
        // event, so it has to make room right away or it drops where it was.
        carry(ev);
      },
      up: () => (lifted.current ? drop() : unlisten()),
    });
  };

  const pull = (panel: HomePanel) => (e: ReactPointerEvent<HTMLElement>): void => {
    if (e.button !== 0 || lifted.current) return;
    e.preventDefault();
    const cell = cellOf(panel.id);
    const area = grid.current?.getBoundingClientRect();
    if (!cell || !area) return;
    const left = cell.getBoundingClientRect().left;
    listen({
      move: (ev) => {
        const span = spanFor((ev.clientX - left) / area.width);
        const next = withSpan(latest.current, panel.id, span);
        if (next !== latest.current) change(next, false);
      },
      up: () => {
        unlisten();
        change(latest.current, true);
      },
    });
  };

  const keyResize = (panel: HomePanel) => (e: ReactKeyboardEvent<HTMLElement>): void => {
    const by = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
    if (!by) return;
    e.preventDefault();
    const at = WIDTHS.indexOf(panel.span) + by;
    const span = WIDTHS[Math.max(0, Math.min(WIDTHS.length - 1, at))]!;
    change(withSpan(latest.current, panel.id, span), true);
  };

  return (
    <>
      <div ref={grid} className={`home-grid${editing ? " is-editing" : ""}`}>
        {panels.map((panel) => (
          /* Laid out rather than snapped: a panel moving aside for the one
             you are carrying is what tells you where it will land. */
          <m.section
            key={panel.id}
            layout
            data-id={panel.id}
            className={`home-cell home-cell--${panel.span}${lift?.id === panel.id ? " is-lifted" : ""}`}
            transition={spring}
            onPointerDown={press(panel)}
          >
            {render(panel)}
            {editing && (
              <>
                <button
                  type="button"
                  className="home-remove"
                  title="Remove"
                  aria-label={`Remove ${panel.title ?? panel.kind}`}
                  onClick={() => onRemove(panel.id)}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
                <div
                  className="home-grip"
                  role="slider"
                  tabIndex={0}
                  aria-label="Width"
                  aria-valuemin={0}
                  aria-valuemax={WIDTHS.length - 1}
                  aria-valuenow={WIDTHS.indexOf(panel.span)}
                  aria-valuetext={panel.span}
                  title="Drag to resize"
                  onPointerDown={pull(panel)}
                  onKeyDown={keyResize(panel)}
                />
              </>
            )}
          </m.section>
        ))}
      </div>
      {lift &&
        createPortal(
          <div
            ref={ghostRef}
            className={`home-ghost home-cell--${panels.find((p) => p.id === lift.id)?.span ?? "half"}`}
            style={{ left: lift.left, top: lift.top, width: lift.width, height: lift.height }}
            aria-hidden="true"
          >
            {lift.content}
          </div>,
          document.body,
        )}
    </>
  );
}
