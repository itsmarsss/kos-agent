import { AUTO_NEVER, AUTO_SESSIONS, AUTO_SPANS, cycled, liveMode, MODE_WORDS, modeLabel, modeTip, spanOf, untilOf, type ChatMode, type ChatModeName } from "@kos/shared";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, m } from "motion/react";

import { BoltIcon, CheckIcon, ChevronDown, HandIcon } from "./icons.js";
import { Switch } from "./kit.js";
import { ease, float } from "./motion.js";
import { useDismiss } from "./useDismiss.js";

/** Shift+Tab in a composer: the key that cycles the chat's mode. */
export function isModeKey(event: Pick<ReactKeyboardEvent | KeyboardEvent, "key" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey">): boolean {
  return event.key === "Tab" && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
}

/** The clock a countdown reads, ticking each half minute while it is shown. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [ticking]);
  return ticking ? now : Date.now();
}

/** The mode with sessions on or off. */
function withSessions(mode: ChatMode, on: boolean): ChatMode {
  const { sessions: _was, ...rest } = mode;
  return on ? { ...rest, sessions: true } : rest;
}

const ICON: Record<ChatModeName, (p: { size?: number }) => ReactElement> = { ask: HandIcon, auto: BoltIcon };

/**
 * The chat's mode in the composer: Ask or Auto, and a menu for how long Auto
 * lasts, whether it starts sessions, and what it never covers. Lit in Auto,
 * and beating while a turn runs under it. The harness decides what Auto lets
 * through; this only sets it.
 *
 * Going into Auto is a choice made in the menu, where it says what it does:
 * a press on the chip in Ask opens the menu rather than switching, so one
 * stray tap never lets KOS go ahead unasked. Back to Ask is one press.
 * Shift+Tab in the box, a chord no one presses by chance, still cycles.
 */
export function ModeChip({ mode, onChange, running = false, disabled = false }: { mode: ChatMode; onChange: (mode: ChatMode) => void; running?: boolean; disabled?: boolean }): ReactElement {
  const now = useNow(typeof mode.until === "number");
  const live = liveMode(mode, now);
  const [open, setOpen] = useState(false);
  const chip = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [spot, setSpot] = useState<{ left: number; bottom: number; maxHeight: number } | null>(null);
  // Shut, the focus goes back to the chip when it was in the menu, rather than to the top of the page.
  useDismiss(
    open,
    () => {
      const held = menu.current?.contains(document.activeElement) === true;
      setOpen(false);
      if (held) chip.current?.querySelector<HTMLButtonElement>(".mode-chip-main")?.focus();
    },
    { inside: [chip, menu] },
  );

  // Above the chip, inside the window side to side: the side panel is narrow and the chip sits mid-row.
  useLayoutEffect(() => {
    if (!open) return;
    const at = chip.current?.getBoundingClientRect();
    const width = menu.current?.offsetWidth ?? 0;
    if (!at) return;
    // As tall as the room above the chip allows; past that it scrolls.
    setSpot({ left: Math.max(8, Math.min(at.left, window.innerWidth - width - 8)), bottom: window.innerHeight - at.top + 6, maxHeight: at.top - 14 });
  }, [open]);
  // Placed (hidden until then, and a hidden row takes no focus), the focus goes in, onto the mode in force: going into Auto is then a step down and a press, never the first key.
  const placed = open && spot !== null;
  useLayoutEffect(() => {
    if (placed) menu.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')?.focus({ preventScroll: true });
  }, [placed]);
  const walk = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const rows = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]:not(:disabled), summary') ?? [])];
    const now = rows.indexOf(document.activeElement as HTMLElement);
    rows[(now + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
  };

  const Icon = ICON[live.mode];
  const span = spanOf(live);
  const set = (next: ChatMode): void => {
    onChange(next);
    if (next.mode === "auto" && live.mode === "ask") setOpen(false);
  };
  const inAuto = live.mode === "auto";
  return (
    <span ref={chip} className="mode-chip" data-mode={live.mode} data-running={(running && live.mode === "auto") || undefined}>
      <button type="button" className="mode-chip-main" disabled={disabled} title={modeTip(live, now)} aria-label={`Mode: ${modeLabel(live, now)}. ${inAuto ? "Press for Ask." : "Press to choose."}`} aria-haspopup={inAuto ? undefined : "menu"} onClick={() => (inAuto ? set(cycled(live)) : setOpen((o) => !o))}>
        <Icon size={12} />
        <span>{MODE_WORDS[live.mode].label}</span>
        {/* How long Auto has left, which a narrow composer leaves to the tooltip. */}
        {modeLabel(live, now) !== MODE_WORDS[live.mode].label && <span className="mode-chip-left">{modeLabel(live, now).slice(MODE_WORDS[live.mode].label.length)}</span>}
      </button>
      <button type="button" className="mode-chip-more" disabled={disabled} aria-label="Mode options" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <ChevronDown size={10} title="" />
      </button>
      {createPortal(
        <AnimatePresence>
          {open && (
          <m.div ref={menu} className="mode-menu kos-pop" role="menu" style={spot ? { ...spot, transformOrigin: "bottom left" } : { visibility: "hidden" }} variants={float} initial="hidden" animate="show" exit="hidden" transition={ease} onKeyDown={walk}>
            {(["ask", "auto"] as const).map((name) => {
              const Mark = ICON[name];
              return (
                <button key={name} type="button" role="menuitemradio" aria-checked={live.mode === name} className="mode-menu-row" onClick={() => set(name === "ask" ? { mode: "ask" } : { mode: "auto", ...(live.sessions ? { sessions: true } : {}) })}>
                  <Mark size={13} />
                  <span className="line-text line-text--wrap">
                    <strong>{MODE_WORDS[name].label}</strong>
                    <span>{MODE_WORDS[name].short}</span>
                  </span>
                  {live.mode === name && <CheckIcon size={13} title="" />}
                </button>
              );
            })}
            <div className="mode-menu-head label">Auto lasts</div>
            <div className="mode-menu-spans" role="group" aria-label="Auto lasts">
              {AUTO_SPANS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="menuitemradio"
                  title={s.label}
                  aria-label={s.label}
                  aria-checked={live.mode === "auto" && span === s.id}
                  onClick={() => {
                    const until = untilOf(s.id, Date.now());
                    set({ mode: "auto", ...(until !== undefined ? { until } : {}), ...(live.sessions ? { sessions: true } : {}) });
                  }}
                >
                  {s.short}
                </button>
              ))}
            </div>
            <label className="mode-menu-switch">
              <span className="line-text line-text--wrap">
                <strong>{AUTO_SESSIONS.label}</strong>
                <span>{AUTO_SESSIONS.hint}</span>
              </span>
              <Switch label={AUTO_SESSIONS.label} on={live.sessions === true} disabled={live.mode !== "auto"} onChange={(on) => set(withSessions(live, on))} />
            </label>
            {/* Folded: a dozen lines open made the menu nearly the window's height, over the thread. */}
            <details className="mode-menu-fold">
              <summary className="mode-menu-head mode-menu-fold-head">What Auto never does</summary>
              <ul className="mode-menu-never">
                {AUTO_NEVER.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </details>
          </m.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </span>
  );
}
