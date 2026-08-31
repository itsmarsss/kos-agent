import { useEffect, useRef, useState, type ReactElement } from "react";
import { AnimatePresence, m } from "motion/react";

import { ease } from "./motion.js";

/**
 * A dropdown that belongs to this surface.
 *
 * A native select renders with the operating system's own chrome, which is the
 * one control on the page that ignores everything else about how the app
 * looks. Keyboard behaviour is kept: arrows move, Enter picks, Escape closes.
 */

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
  const root = useRef<HTMLDivElement>(null);

  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (open) setCursor(Math.max(0, options.findIndex((o) => o.value === value)));
  }, [open, options, value]);

  const pick = (next: string): void => {
    onChange(next);
    setOpen(false);
  };

  return (
    <div className={`sel ${className}`} ref={root}>
      <button
        type="button"
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

      <AnimatePresence>
        {open && (
          <m.ul
            className="sel-menu"
            role="listbox"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={ease}
            tabIndex={-1}
            // Focused on mount so the keys work without a second click.
            ref={(el) => el?.focus()}
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
                  {opt.hint && <span className="sel-option-hint">{opt.hint}</span>}
                </button>
              </li>
            ))}
          </m.ul>
        )}
      </AnimatePresence>
    </div>
  );
}
