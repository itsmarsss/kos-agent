import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, m } from "motion/react";

import { ease } from "./motion.js";

/**
 * A dropdown that belongs to this surface.
 *
 * A native select renders with the operating system's own chrome, which is the
 * one control on the page that ignores everything else about how the app
 * looks. Keyboard behaviour is kept: arrows move, Enter picks, Escape closes.
 *
 * The menu is rendered into the document body rather than beside its button.
 * Absolutely positioned inside a card it was clipped by any ancestor that
 * scrolls and stacked below anything with a higher z-index further up the
 * tree, so a long list like the timezone picker came out cut off or covered.
 * Being taken out of the flow it also has to be told where to go, and to
 * close when the page moves underneath it.
 */

/** Space to leave between the menu and the edge of the window. */
const MARGIN = 8;

export interface Placement {
  left: number;
  top?: number;
  bottom?: number;
  minWidth: number;
  maxHeight: number;
}

/**
 * Put the menu under its button, or above it when there is more room there.
 * Measured against the viewport because the menu is positioned fixed.
 */
export function place(button: DOMRect): Placement {
  const below = window.innerHeight - button.bottom - MARGIN;
  const above = button.top - MARGIN;
  const openUp = below < 180 && above > below;
  const left = Math.max(
    MARGIN,
    Math.min(button.left, window.innerWidth - button.width - MARGIN),
  );
  return {
    left,
    ...(openUp
      ? { bottom: window.innerHeight - button.top + 6 }
      : { top: button.bottom + 6 }),
    minWidth: button.width,
    maxHeight: Math.max(140, (openUp ? above : below) - 6),
  };
}

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
}

export function Select({
  value,
  options,
  onChange,
  label,
  disabled,
  className = "",
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [at, setAt] = useState<Placement | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLUListElement>(null);

  const current = options.find((o) => o.value === value);

  const measure = useCallback(() => {
    const rect = button.current?.getBoundingClientRect();
    if (rect) setAt(place(rect));
  }, []);

  // Before paint, so the menu never appears in the wrong place first.
  useLayoutEffect(() => {
    if (open) measure();
  }, [open, measure]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event): void => {
      const target = e.target as Node;
      if (root.current?.contains(target)) return;
      if (menu.current?.contains(target)) return;
      setOpen(false);
    };
    // Any scroll, anywhere, including inside a panel: a menu positioned
    // against the viewport would otherwise sit still while the control it
    // belongs to slides away underneath it.
    const onScroll = (): void => setOpen(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", measure);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", measure);
    };
  }, [open, measure]);

  useEffect(() => {
    if (open)
      setCursor(
        Math.max(
          0,
          options.findIndex((o) => o.value === value),
        ),
      );
  }, [open, options, value]);

  const pick = (next: string): void => {
    onChange(next);
    setOpen(false);
  };

  return (
    <div className={`sel ${className}`} ref={root}>
      <button
        type="button"
        ref={button}
        className="sel-button"
        aria-label={label}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="sel-value">{current?.label ?? value}</span>
        <span className="sel-caret" aria-hidden="true">
          ⌄
        </span>
      </button>

      {createPortal(
        <AnimatePresence>
          {open && at && (
            <m.ul
              className="sel-menu"
              role="listbox"
              style={{
                left: at.left,
                ...(at.top !== undefined ? { top: at.top } : {}),
                ...(at.bottom !== undefined ? { bottom: at.bottom } : {}),
                minWidth: at.minWidth,
                maxHeight: at.maxHeight,
              }}
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={ease}
              tabIndex={-1}
              // Focused on mount so the keys work without a second click.
              ref={(el) => {
                menu.current = el;
                el?.focus();
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") setOpen(false);
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setCursor((c) => (c + 1) % options.length);
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setCursor((c) => (c - 1 + options.length) % options.length);
                }
                if (e.key === "Enter") {
                  e.preventDefault();
                  const opt = options[cursor];
                  if (opt) pick(opt.value);
                }
              }}
            >
              {options.map((opt, i) => (
                <li key={opt.value}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={opt.value === value}
                    className={`sel-option ${i === cursor ? "is-cursor" : ""} ${
                      opt.value === value ? "is-on" : ""
                    }`}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => pick(opt.value)}
                  >
                    <span className="sel-option-label">{opt.label}</span>
                    {opt.hint && (
                      <span className="sel-option-hint">{opt.hint}</span>
                    )}
                  </button>
                </li>
              ))}
            </m.ul>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}
