import { useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";

import { m } from "motion/react";
import { useDismiss } from "@kos/kit";

/**
 * The file manager's menu: what a right click on a row or the ⋯ in the
 * toolbar opens, for whatever is selected. Drawn at the body, fixed to the
 * viewport and nudged inside it, so a list that clips its overflow never
 * cuts it off. Escape, a press away or a scroll closes it.
 */

export interface MenuItem {
  label: string;
  act: () => void;
  danger?: boolean;
  /** A rule above it: the start of another group. */
  divided?: boolean;
  disabled?: boolean;
  /** The keys that do the same, said at the right. */
  keys?: string;
}

export function FinderMenu({ at, items, onClose, label }: { at: { x: number; y: number }; items: MenuItem[]; onClose: () => void; label: string }): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ left: at.x, top: at.y });
  useDismiss(true, onClose, { inside: [ref] });
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    setPlace({
      left: Math.max(8, Math.min(at.x, window.innerWidth - box.width - 8)),
      top: at.y + box.height > window.innerHeight - 8 ? Math.max(8, at.y - box.height) : at.y,
    });
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [at.x, at.y]);

  const step = (e: React.KeyboardEvent): void => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(at + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  };

  return createPortal(
    <m.div
      ref={ref}
      className="chats-menu finder-menu"
      role="menu"
      aria-label={label}
      style={place}
      onKeyDown={step}
      onContextMenu={(e) => e.preventDefault()}
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.1 }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={`${item.danger ? "is-danger" : ""}${item.divided ? " is-divided" : ""}`}
          disabled={item.disabled}
          onClick={() => {
            onClose();
            item.act();
          }}
        >
          <span>{item.label}</span>
          {item.keys && <kbd className="finder-menu-keys">{item.keys}</kbd>}
        </button>
      ))}
    </m.div>,
    document.body,
  );
}
