import type { BlobMood } from "@kos/shared/blobmotion";
import { AnimatePresence, m, type Transition, type Variants } from "motion/react";
import { useEffect, useRef, type ReactElement, type ReactNode } from "react";

import { kosFace, type KosFace } from "../face.js";

/**
 * The pieces the extension's pages are made of, in KOS Device's design and
 * the dashboard's motion: the same spring and ease as packages/ui/src/motion.ts,
 * so a drawer opening here moves as one does there and on the Mac.
 */

export const spring: Transition = { type: "spring", stiffness: 420, damping: 38, mass: 0.9 };
export const ease: Transition = { duration: 0.18, ease: [0.32, 0.72, 0, 1] };

/** A card lifting into place, its siblings after it. */
export const rise: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: ease },
  exit: { opacity: 0, y: -4, transition: { duration: 0.12 } },
};
export const stagger: Variants = { hidden: {}, show: { transition: { staggerChildren: 0.04, delayChildren: 0.02 } } };

/** KOS's face, alive: the dashboard's blob, mounted once and told its mood as it changes. */
export function Face({ size, mood }: { size: number; mood: BlobMood }): ReactElement {
  const holder = useRef<HTMLSpanElement>(null);
  const face = useRef<KosFace | null>(null);
  // The mood it is born in; later moods are pushed, so a new one does not make a new blob.
  const born = useRef(mood);
  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const made = kosFace(size, born.current);
    face.current = made;
    el.replaceChildren(made.el);
    return () => {
      made.dispose();
      el.replaceChildren();
      face.current = null;
    };
  }, [size]);
  useEffect(() => face.current?.setMood(mood), [mood]);
  return <span ref={holder} className="face-holder" />;
}

export type Tone = "ok" | "accent" | "warn" | "danger" | "muted";

/** A state in a word; a new word cross-fades in place of the old, the pill growing or shrinking to fit it. */
export function Pill({ tone, children }: { tone: Tone; children: string }): ReactElement {
  return (
    <m.span className="pill" data-tone={tone} layout style={{ borderRadius: 999 }} transition={spring}>
      <AnimatePresence mode="popLayout" initial={false}>
        <m.span key={children} layout="position" initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={ease}>
          {children}
        </m.span>
      </AnimatePresence>
    </m.span>
  );
}

export function Section({ label, action, children }: { label: string; action?: ReactNode; children: ReactNode }): ReactElement {
  return (
    <m.section className="section" variants={rise} layout="position">
      <div className="section-head">
        <p className="label">{label}</p>
        {action}
      </div>
      {children}
    </m.section>
  );
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }): ReactElement {
  return (
    <button type="button" className="switch" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}>
      <m.span layout transition={spring} />
    </button>
  );
}

export function Chips<V extends string | number>({ options, selected, onChoose }: { options: [V, string][]; selected: V; onChoose: (v: V) => void }): ReactElement {
  return (
    <div className="chips">
      {options.map(([value, label]) => (
        <button key={String(value)} type="button" aria-pressed={value === selected} onClick={() => onChoose(value)}>
          {label}
        </button>
      ))}
    </div>
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
    <button type="button" className="drawer" aria-expanded={open} onClick={onToggle}>
      <span className="tile" data-tone={tone}>
        {icon}
      </span>
      <span className="line-text">
        <strong>{title}</strong>
        <span>{detail}</span>
      </span>
      {trailing}
      <m.span className="chev" animate={{ rotate: open ? 180 : 0 }} transition={spring}>
        <Icon path={ICONS.chevron} size={12} />
      </m.span>
    </button>
  );
}

export function Icon({ path, size = 15 }: { path: string; size?: number }): ReactElement {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: path }} />;
}

export const ICONS = {
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  hidden: '<path d="M9.9 4.2A10 10 0 0 1 12 4c7 0 10 8 10 8a17 17 0 0 1-3.2 4.5M6.6 6.6A17 17 0 0 0 2 12s3 8 10 8a10 10 0 0 0 5.4-1.6"/><path d="M3 3l18 18M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  back: '<path d="m15 6-6 6 6 6"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8a8 8 0 0 0 16 0v-3a2 2 0 0 0-4 0"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  send: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  page: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
};

/** Ask the worker; its answer or its refusal. */
export async function ask<T>(message: Record<string, unknown>): Promise<T> {
  const answer = (await chrome.runtime.sendMessage(message)) as { ok: boolean; value?: T; error?: string };
  if (!answer?.ok) throw new Error(answer?.error ?? "the extension did not answer");
  return answer.value as T;
}

export const minutesWords = (m: number): string => (m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60}` : `${m / 60} h`);

export function minutesLeft(until: number, now = Date.now()): string {
  const left = Math.max(0, Math.ceil((until - now) / 60_000));
  return left <= 1 ? "under a minute left" : `${minutesWords(left)} left`;
}
