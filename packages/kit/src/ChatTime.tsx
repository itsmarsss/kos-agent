import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FocusEvent, type PointerEvent, type ReactElement, type ReactNode } from "react";

import { clockWords, dayNumber, markWords, timeCard, type TimeMark } from "@kos/shared";

import { Tooltip } from "./Tooltip.js";

/**
 * When a chat's messages were said, as the dashboard and KOS for Chrome draw
 * it (`@kos/shared` chattime.ts has the rules): a quiet line where the day
 * changes or after a long pause, and each message's own time, shown on
 * hover, on keyboard focus inside the message, or on a tap where nothing
 * hovers.
 */

/** The date in full over the time on the reader's clock, one line each: the card a time opens. */
export function TimeCard({ seconds }: { seconds: number }): ReactElement {
  const [date, time] = timeCard(seconds);
  return (
    <span className="md-time-card">
      <span>{date}</span>
      <span>{time}</span>
    </span>
  );
}

/** The reader's day, told to every day line at once when it turns, so "Today" becomes "Yesterday" at midnight. */
let today = dayNumber(Date.now());
const turned = new Set<() => void>();
let ticking: ReturnType<typeof setInterval> | undefined;

function onTurn(listener: () => void): () => void {
  if (!turned.size) {
    today = dayNumber(Date.now());
    ticking = setInterval(() => {
      const now = dayNumber(Date.now());
      if (now === today) return;
      today = now;
      for (const told of turned) told();
    }, 60_000);
  }
  turned.add(listener);
  return () => {
    turned.delete(listener);
    if (!turned.size) clearInterval(ticking);
  };
}

/** The reader's day as days since 1970, redrawn when it turns. */
export function useToday(): number {
  return useSyncExternalStore(onTurn, () => today);
}

/** The line over a message where the day changes ("Today") or after a pause ("9:41 AM"): read as text, not skipped as a rule. */
export function TimeLine({ mark }: { mark: TimeMark }): ReactElement {
  useToday();
  return (
    <div className="chat-mark">
      <time dateTime={new Date(mark.at).toISOString()}>{markWords(mark)}</time>
    </div>
  );
}

/** A message's own time, hidden until its message is hovered, focused or tapped; its card says the date in full. */
export function MessageTime({ at }: { at: number }): ReactElement {
  return (
    <Tooltip tip={<TimeCard seconds={at / 1000} />}>
      <time className="msg-time" dateTime={new Date(at).toISOString()}>
        {clockWords(at)}
      </time>
    </Tooltip>
  );
}

/** Whether a press landed on something of its own to press, which a tap on the message leaves alone. */
function onControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("a, button, input, textarea, select, [role='button'], .msg-time") !== null;
}

/** How long a time a tap showed stays before it hides again. */
export const TAPPED_MS = 4_000;

/** What a message hands its element so it shows its time: the pointer over it, focus inside it, a tap on it. */
export interface TimeRevealProps {
  ref: (element: HTMLElement | null) => void;
  onPointerEnter: (event: PointerEvent<HTMLElement>) => void;
  onPointerLeave: (event: PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLElement>) => void;
  onFocus: () => void;
  onBlur: (event: FocusEvent<HTMLElement>) => void;
}

/**
 * Whether a message shows its time: while a mouse is over it, while focus
 * is inside it, and, where nothing hovers, after a tap on it (a touch or a
 * pen, not on a link or button in it), for a few seconds, until another tap
 * on it or a press anywhere else.
 */
export function useTimeReveal(): { shown: boolean; props: TimeRevealProps } {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [tapped, setTapped] = useState(false);
  const element = useRef<HTMLElement | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    element.current = el;
  }, []);
  useEffect(() => {
    if (!tapped) return undefined;
    const timer = setTimeout(() => setTapped(false), TAPPED_MS);
    const away = (event: Event): void => {
      if (!(event.target instanceof Node && element.current?.contains(event.target))) setTapped(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", away, true);
    };
  }, [tapped]);
  return {
    shown: hovered || focused || tapped,
    props: {
      ref,
      onPointerEnter: (event) => {
        if (event.pointerType === "mouse") setHovered(true);
      },
      onPointerLeave: () => setHovered(false),
      onPointerUp: (event) => {
        if (event.pointerType === "mouse" || onControl(event.target)) return;
        if (window.getSelection()?.toString()) return;
        setTapped((t) => !t);
      },
      onFocus: () => setFocused(true),
      onBlur: (event) => {
        if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setFocused(false);
      },
    },
  };
}

/** A message that shows its time on hover, focus or a tap: `.is-timed` while it does. */
export function Timed({ className, label, children }: { className: string; /** Who said it and when, for a screen reader: the message is then an article by that name. */ label?: string; children: ReactNode }): ReactElement {
  const { shown, props } = useTimeReveal();
  return (
    <div className={shown ? `${className} is-timed` : className} {...(label ? { role: "article", "aria-label": label } : {})} {...props}>
      {children}
    </div>
  );
}
