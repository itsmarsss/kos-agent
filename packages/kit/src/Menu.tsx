import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, m } from "motion/react";

import { CheckIcon } from "./icons.js";
import { ease, float } from "./motion.js";
import { useDismiss } from "./useDismiss.js";

/** One thing a menu does. */
export interface MenuItem {
  label: string;
  act: () => void;
  danger?: boolean;
  /** A rule above it: the start of another group. */
  divided?: boolean;
  disabled?: boolean;
  /** The keys that do the same, said at the right. */
  keys?: string;
  /** One of a set of choices (the view, the sort): ticked when it is the one in force. */
  checked?: boolean;
}

/** Which side of what opened it a menu hangs from, and which of its edges lines up with it. */
export type MenuSide = "below" | "above" | "right";

export interface MenuProps {
  open: boolean;
  onClose: () => void;
  /** What a screen reader calls it. */
  label: string;
  /** The button that opened it: the menu hangs from it, and the focus goes back to it on Escape. */
  anchor?: RefObject<HTMLElement | null>;
  /** Or a point (a right click, a selected row): the menu's corner goes there. */
  at?: { x: number; y: number };
  side?: MenuSide;
  /** Which edges line up: the anchor's start with the menu's, or its end with the menu's. */
  align?: "start" | "end";
  items?: MenuItem[];
  /** Rows of its own (a confirm), after the items; each a `.kos-menu-row` with a menu role. */
  children?: ReactNode;
  className?: string;
}

const GAP = 6;
const MARGIN = 8;
const ROWS = "[role^='menuitem']:not(:disabled)";

/** Where the menu's box goes: against its side of the anchor, flipped when there is no room, kept inside the window. */
export function menuPlace(box: { width: number; height: number }, anchor: DOMRect | null, at: { x: number; y: number } | undefined, side: MenuSide, align: "start" | "end"): { left: number; top: number; origin: string } {
  const room = { width: window.innerWidth, height: window.innerHeight };
  const clamp = (v: number, size: number, max: number): number => Math.max(MARGIN, Math.min(v, max - size - MARGIN));
  if (!anchor) {
    const x = at?.x ?? 0;
    const y = at?.y ?? 0;
    const up = y + box.height > room.height - MARGIN && y - box.height >= MARGIN;
    return { left: clamp(x, box.width, room.width), top: clamp(up ? y - box.height : y, box.height, room.height), origin: up ? "bottom left" : "top left" };
  }
  if (side === "right") {
    const fits = anchor.right + GAP + box.width <= room.width - MARGIN;
    const left = fits ? anchor.right + GAP : anchor.left - GAP - box.width;
    const top = align === "end" ? anchor.bottom - box.height : anchor.top;
    return { left: clamp(left, box.width, room.width), top: clamp(top, box.height, room.height), origin: `${align === "end" ? "bottom" : "top"} ${fits ? "left" : "right"}` };
  }
  const below = room.height - anchor.bottom - GAP - MARGIN;
  const above = anchor.top - GAP - MARGIN;
  const down = side === "below" ? box.height <= below || below >= above : box.height > above && below > above;
  const top = down ? anchor.bottom + GAP : anchor.top - GAP - box.height;
  const left = align === "end" ? anchor.right - box.width : anchor.left;
  return { left: clamp(left, box.width, room.width), top: clamp(top, box.height, room.height), origin: `${down ? "top" : "bottom"} ${align === "end" ? "right" : "left"}` };
}

/**
 * The one menu: what a ⋯, a More or a right click opens. Drawn at the body,
 * fixed and kept inside the window, so a list that clips its overflow never
 * cuts it off; placed before it is first painted, so it fades in where and
 * as big as it will be (a fade and a scale from 0.98, from the corner it
 * hangs by). One geometry (docs/design.md, Menu): `panel`, a `line-strong`
 * border, radius 10 and 3 px in, rows of 7.
 *
 * Its keys: the focus goes to the first row as it opens, the arrows, Home and
 * End walk the rows, Escape shuts it and gives the focus back to what opened
 * it, Tab shuts it and goes on. A press away, a scroll or a resize shuts it.
 */
export function Menu({ open, onClose, label, anchor, at, side = "below", align = "end", items = [], children, className }: MenuProps): ReactElement {
  return createPortal(
    <AnimatePresence>
      {open && (
        <MenuBox onClose={onClose} label={label} anchor={anchor} at={at} side={side} align={align} items={items} className={className}>
          {children}
        </MenuBox>
      )}
    </AnimatePresence>,
    document.body,
  );
}

function MenuBox({ onClose, label, anchor, at, side, align, items, children, className }: Required<Pick<MenuProps, "onClose" | "label" | "side" | "align" | "items">> & Pick<MenuProps, "anchor" | "at" | "children" | "className">): ReactElement {
  const box = useRef<HTMLDivElement>(null);
  const [spot, setSpot] = useState<{ left: number; top: number; origin: string } | null>(null);
  useDismiss(true, onClose, { inside: [box, ...(anchor ? [anchor] : [])], escape: false });
  // Measured and placed before the first paint, then the focus goes in.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setSpot(menuPlace({ width: el.offsetWidth, height: el.offsetHeight }, anchor?.current?.getBoundingClientRect() ?? null, at, side, align));
    el.querySelector<HTMLElement>(ROWS)?.focus({ preventScroll: true });
  }, [at?.x, at?.y]);
  const ticks = items.some((item) => item.checked !== undefined);

  const shut = (back: boolean): void => {
    onClose();
    if (back) anchor?.current?.focus();
  };
  const keys = (e: KeyboardEvent<HTMLDivElement>): void => {
    const rows = [...(box.current?.querySelectorAll<HTMLElement>(ROWS) ?? [])];
    const now = rows.indexOf(document.activeElement as HTMLElement);
    const go = (i: number): void => {
      e.preventDefault();
      rows[(i + rows.length) % rows.length]?.focus();
    };
    if (e.key === "ArrowDown") go(now + 1);
    else if (e.key === "ArrowUp") go(now < 0 ? -1 : now - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(-1);
    else if (e.key === "Escape") {
      // Its own Escape, never the sheet's it is drawn over.
      e.preventDefault();
      e.stopPropagation();
      shut(true);
    } else if (e.key === "Tab") shut(false);
  };

  return (
    <m.div
      ref={box}
      className={["kos-menu", "kos-pop", className].filter(Boolean).join(" ")}
      role="menu"
      aria-label={label}
      style={spot ? { left: spot.left, top: spot.top, transformOrigin: spot.origin } : { left: 0, top: 0, visibility: "hidden" }}
      variants={float}
      initial="hidden"
      animate="show"
      exit="hidden"
      transition={ease}
      onKeyDown={keys}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role={item.checked === undefined ? "menuitem" : "menuitemradio"}
          aria-checked={item.checked}
          tabIndex={-1}
          className={["kos-menu-row", item.danger && "is-danger", item.divided && "is-divided"].filter(Boolean).join(" ")}
          disabled={item.disabled}
          onClick={() => {
            onClose();
            item.act();
          }}
        >
          {ticks && <span className="kos-menu-tick">{item.checked && <CheckIcon size={13} title="" />}</span>}
          <span className="kos-menu-label">{item.label}</span>
          {item.keys && <kbd className="kos-menu-keys">{item.keys}</kbd>}
        </button>
      ))}
      {children}
    </m.div>
  );
}
