import { AnimatePresence, m, type HTMLMotionProps } from "motion/react";
import type { ReactElement, ReactNode } from "react";

import { ChevronDown } from "./icons.js";
import { ease, listItem, spring } from "./motion.js";

/**
 * The small pieces the dashboard and KOS for Chrome are both made of, in
 * KOS's design language (docs/design.md), drawn by kit.css on the shared
 * tokens so a pill, a switch or a drawer is the same thing on either.
 */

export type Tone = "ok" | "warn" | "danger" | "accent" | "muted";

/** A state in a word: on, paused, failed. Coloured by what it means. */
export function Pill({ tone = "muted", title, children }: { tone?: Tone; title?: string; children: ReactNode }): ReactElement {
  return (
    <span className={`pill pill--${tone}`} title={title}>
      {children}
    </span>
  );
}

/** A fact in a word or two: a tool family, a model class, a value. Not a button, and not a state (that is a Pill). */
export function Tag({ mono = false, title, children }: { mono?: boolean; title?: string; children: ReactNode }): ReactElement {
  return (
    <span className={`tag${mono ? " tag--mono" : ""}`} title={title}>
      {children}
    </span>
  );
}

/** On or off, said by its label and drawn as a knob that slides. */
export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }): ReactElement {
  return (
    <button type="button" className="switch" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}>
      <m.span layout transition={spring} />
    </button>
  );
}

/** A chip's value, what it says, and what its tooltip says. */
export type ChipOption<V> = readonly [value: V, label: ReactNode, title?: string];

/**
 * One of a few values, each a chip; the chosen one is pressed. A filter, a
 * kind, tabs over a list: every such choice is drawn this way. With nothing
 * selected, the chips are a row of things to pick, none of them on.
 */
export function Chips<V extends string | number>({ options, selected, onChoose, label, small = false }: { options: readonly ChipOption<V>[]; selected?: V | null; onChoose: (v: V) => void; label?: string; small?: boolean }): ReactElement {
  return (
    <div className={`chips${small ? " chips--sm" : ""}`} role={label ? "group" : undefined} aria-label={label}>
      {options.map(([value, text, title]) => (
        <button key={String(value)} type="button" aria-pressed={value === selected} title={title} onClick={() => onChoose(value)}>
          {text}
        </button>
      ))}
    </div>
  );
}

export interface IconButtonProps extends HTMLMotionProps<"button"> {
  /** What it does, for a screen reader and the tooltip. */
  label: string;
  /** danger turns red under the pointer; bare has no ring. */
  tone?: "danger" | "bare";
}

/** A round button holding one icon: quiet until the pointer is over it. */
export function IconButton({ label, tone, className, title, type = "button", ...rest }: IconButtonProps): ReactElement {
  const cls = ["icon-btn", tone ? `icon-btn--${tone}` : "", className ?? ""].filter(Boolean).join(" ");
  return <m.button type={type} className={cls} aria-label={label} title={title ?? label} {...rest} />;
}

/** KOS at work before it has a step to show: three dots, one after another. */
export function WorkingDots(): ReactElement {
  return (
    <span className="live-dots" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

/** A small uppercase head over what it labels, with an action at its right. */
export function Section({ label, action, children }: { label: string; action?: ReactNode; children: ReactNode }): ReactElement {
  return (
    <m.section className="section" variants={listItem} layout="position">
      <div className="section-head">
        <p className="label">{label}</p>
        {action}
      </div>
      {children}
    </m.section>
  );
}

/** What is under a drawer: it opens to its height and closes from it, fading as it goes. */
export function Collapse({ open, children }: { open: boolean; children: ReactNode }): ReactElement {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <m.div
          className="collapse"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1, transition: { height: spring, opacity: { ...ease, delay: 0.05 } } }}
          exit={{ height: 0, opacity: 0, transition: { height: spring, opacity: { duration: 0.1 } } }}
        >
          <div className="collapse-body">{children}</div>
        </m.div>
      )}
    </AnimatePresence>
  );
}

/** A row that opens what is under it: an icon on its tint, a title, a line of detail, what it carries on the right, a chevron. */
export function DrawerRow({ icon, tone, title, detail, open, onToggle, trailing }: { icon: ReactNode; tone: Tone; title: string; detail: string; open: boolean; onToggle: () => void; trailing?: ReactNode }): ReactElement {
  return (
    <button type="button" className="drawer-row" aria-expanded={open} onClick={onToggle}>
      <span className="tile" data-tone={tone}>
        {icon}
      </span>
      <span className="line-text">
        <strong>{title}</strong>
        <span>{detail}</span>
      </span>
      {trailing}
      <m.span className="chev" animate={{ rotate: open ? 180 : 0 }} transition={spring}>
        <ChevronDown size={12} />
      </m.span>
    </button>
  );
}
