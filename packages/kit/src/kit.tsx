import { AnimatePresence, m, type HTMLMotionProps } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactElement, type ReactNode } from "react";

import { stepMechanics } from "@kos/shared";

import { ChevronDown, CloseIcon, QuoteIcon } from "./icons.js";
import { hover, inPlace, listItem, spring } from "./motion.js";
import { Tooltip } from "./Tooltip.js";

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

/**
 * A fact in a word or two: a tool family, a model class, a value. Not a
 * button, and not a state (that is a Pill). With `remove`, it ends in a
 * small × that takes it away: a hidden site, a hidden app.
 */
export function Tag({ mono = false, title, remove, children }: { mono?: boolean; title?: string; remove?: { label: string; onRemove: () => void }; children: ReactNode }): ReactElement {
  return (
    <span className={`tag${mono ? " tag--mono" : ""}${remove ? " tag--removable" : ""}`} title={title}>
      {children}
      {remove && (
        <IconButton tone="bare" label={remove.label} onClick={remove.onRemove}>
          <CloseIcon size={10} title="" />
        </IconButton>
      )}
    </span>
  );
}

/** What a dot can say. Blue is working, yellow is waiting on you, red is broken, green has something unread or is on, grey is read, quiet or off. */
export type DotState = "working" | "needs-you" | "error" | "unread" | "read" | "on" | "off";

/** A state as a dot alone, its word in the tooltip: a thread, a build, a session. */
export function StatusDot({ state, label }: { state: DotState; label: string }): ReactElement {
  return <span className={`status-dot status-dot--${state}`} role="img" aria-label={label} title={label} />;
}

/** How many there are, beside a title or a group's name: a small capsule in the accent (or the card's tint). `more` says there are more than were counted ("500+"). */
export function Count({ n, more = false }: { n: number; more?: boolean }): ReactElement {
  return <span className="count">{more ? `${n}+` : n}</span>;
}

export interface CardProps {
  /** The small uppercase head. Absent, the card is a plain box. */
  title?: string;
  /** Shown beside the title when above zero. */
  count?: number;
  /** A Pill, at the head's right. */
  pill?: ReactNode;
  /** A small button or link, at the head's right. */
  action?: ReactNode;
  /** For a screen reader, when the title is not enough. */
  label?: string;
  className?: string;
  children: ReactNode;
}

/** A boxed section of a column or a page: a head, then its body. What else a section takes (a drop target's handlers) it is given. */
export function Card({ title, count, pill, action, label, className, children, ...rest }: CardProps & Omit<HTMLAttributes<HTMLElement>, keyof CardProps>): ReactElement {
  return (
    <section className={`card${className ? ` ${className}` : ""}`} aria-label={label ?? title} {...rest}>
      {(title || action || pill) && (
        <div className="card-head">
          {title && (
            <h2 className="label card-title">
              {title}
              {count !== undefined && count > 0 && <Count n={count} />}
            </h2>
          )}
          {(pill || action) && (
            <span className="card-acts">
              {pill}
              {action}
            </span>
          )}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * What a list or panel says when there is nothing in it: an answer, not a
 * blank. A page's list says it in a dashed box; inside a card, where the
 * card is already the box, it is one quiet line (inline).
 */
export function Empty({ title, inline = false, className, children }: { title?: string; inline?: boolean; className?: string; children: ReactNode }): ReactElement {
  if (inline) return <p className={`empty-line${className ? ` ${className}` : ""}`}>{children}</p>;
  return (
    <div className={`empty${className ? ` ${className}` : ""}`}>
      {title && <strong className="empty-title">{title}</strong>}
      <p className="empty-text">{children}</p>
    </div>
  );
}

/**
 * Where something will be while it loads: a quiet block in its shape, with a
 * slow sheen (none for those who asked for less motion). A list draws a few
 * in the shape of its rows or cards, so nothing jumps when they arrive.
 */
export function Skeleton({ width, height, radius, className }: { width?: number | string; height?: number | string; radius?: number | string; className?: string }): ReactElement {
  return <span className={`skeleton${className ? ` ${className}` : ""}`} aria-hidden="true" style={{ width, height, borderRadius: radius }} />;
}

/** On or off, said by its label and drawn as a knob that slides. */
export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }): ReactElement {
  return (
    <button type="button" className="switch" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}>
      <m.span layout transition={hover} />
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
export function Chips<V extends string | number>({
  options,
  selected,
  onChoose,
  label,
  small = false,
  scroll = false,
}: {
  options: readonly ChipOption<V>[];
  selected?: V | null;
  onChoose: (v: V) => void;
  label?: string;
  small?: boolean;
  /** One row that scrolls sideways on its own when it runs out of room, rather than wrapping or widening the page. */
  scroll?: boolean;
}): ReactElement {
  return (
    <div className={`chips${small ? " chips--sm" : ""}${scroll ? " chips--scroll" : ""}`} role={label ? "group" : undefined} aria-label={label}>
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

/** An IconButton that goes somewhere: the same circle, as a link. */
export function IconLink({ label, href, title, target, rel, children }: { label: string; href: string; title?: string; target?: string; rel?: string; children: ReactNode }): ReactElement {
  return (
    <a className="icon-btn" href={href} aria-label={label} title={title ?? label} target={target} rel={rel}>
      {children}
    </a>
  );
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

/** 45s, 3m 20s, 1h 4m. A count that only ever grows in seconds stops reading. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** How long KOS has been at it, since a moment in ms, ticking each second. */
export function Elapsed({ since }: { since: number }): ReactElement {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="live-elapsed">{formatElapsed(now - since)}</span>;
}

/**
 * How long an ask has before it lapses on its own, ticking each second:
 * "lapses in 42s", then "lapsing" once its time is up. The approvals and
 * session asks of both device chats show it on the card.
 */
export function Countdown({ until, lead = "lapses in" }: { until: number; lead?: string }): ReactElement {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = until - now;
  return <span className="countdown" data-soon={left < 15_000 || undefined}>{left > 0 ? `${lead} ${formatElapsed(left)}` : "lapsing"}</span>;
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
          animate={{ height: "auto", opacity: 1, transition: { height: spring, opacity: inPlace.enter } }}
          exit={{ height: 0, opacity: 0, transition: { height: spring, opacity: inPlace.exit } }}
        >
          <div className="collapse-body">{children}</div>
        </m.div>
      )}
    </AnimatePresence>
  );
}

/** A row that opens what is under it: an icon on its tint, a title, a line of detail, what it carries on the right, a chevron. */
export function DrawerRow({ icon, tone, title, detail, open, onToggle, trailing, wrap = false }: { icon: ReactNode; tone: Tone; title: string; detail: string; open: boolean; onToggle: () => void; trailing?: ReactNode; wrap?: boolean }): ReactElement {
  return (
    <button type="button" className={wrap ? "drawer-row drawer-row--wrap" : "drawer-row"} aria-expanded={open} onClick={onToggle}>
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

/**
 * What a step saw (a tab, a screen): small under the step, larger on a
 * press, smaller again on another. One piece wherever steps are shown, so
 * the dashboard's thread and KOS for Chrome's side panel show a step's
 * picture the same way.
 */
export function StepPicture({ src, alt = "What this step saw" }: { src: string; alt?: string }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <button type="button" className={`step-picture${open ? " is-open" : ""}`} onClick={() => setOpen((v) => !v)} title={open ? "Smaller" : alt} aria-expanded={open}>
      <img src={src} alt={alt} loading="lazy" />
    </button>
  );
}

/** Where a quote came from, as a person names it: a page's site, or the app's name as the Mac gave it. */
export function quoteSource(from: string): string {
  return /^https?:\/\/(?:www\.)?([^/:?#]+)/i.exec(from)?.[1] ?? from;
}

/**
 * What the owner quoted with their words (text they selected on a page or
 * in an app): a small head with the quote mark, a label and where it came
 * from, then the words in quotes, cut to a few lines, on a soft tint. In the
 * composer it is the attachment going with the next message, `label`led and
 * with `onRemove` as its ×; in the owner's bubble, what went with it. Cut
 * short, the whole of it is in a Tooltip. The dashboard's thread and both
 * device chats draw it; KOS for Mac's is `QuoteCard`.
 */
export function QuoteLine({ text, from, label, lines = 3, onRemove }: { text: string; from?: string; label?: string; lines?: number; onRemove?: () => void }): ReactElement {
  const box = useRef<HTMLDivElement>(null);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const measure = (): void => {
      const words = el.firstElementChild;
      setCut(!!words && words.scrollHeight > words.clientHeight + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [text, lines]);
  const source = from ? quoteSource(from) : "";
  const words = (
    <p className="quoted-text" style={{ WebkitLineClamp: lines }}>
      {text}
    </p>
  );
  return (
    <div className={`quoted${onRemove ? " quoted--chip" : ""}`}>
      <div className="quoted-head">
        <QuoteIcon />
        <span className="quoted-label">{label ?? (source || "Quoted")}</span>
        {label && source && <span className="quoted-from">{source}</span>}
        {onRemove && (
          <IconButton tone="bare" label="Leave the selection out" title="Leave it out" onClick={onRemove}>
            <CloseIcon size={10} title="" />
          </IconButton>
        )}
      </div>
      <div ref={box}>{cut ? <Tooltip tip={<span className="quoted-tip">{text}</span>}>{words}</Tooltip> : words}</div>
    </div>
  );
}

/**
 * Under an ask's summary, the actions it would take, where the summary is
 * the model's account of a step rather than the step: "Close the popup"
 * over "Type “hunter2”, press cmd+q". The yes is for these, so they are on
 * the row itself, never behind a fold and never cut; a long run wraps.
 * From the host's `mechanics` when it sent them, else from the arguments.
 */
export function AskSteps({ mechanics, tool, args }: { mechanics?: string | undefined; tool?: string; args?: string | Record<string, unknown> }): ReactElement | null {
  const steps = mechanics ?? (tool && args !== undefined ? stepMechanics(tool, args) : undefined);
  return steps ? <span className="ask-steps">{steps}</span> : null;
}
