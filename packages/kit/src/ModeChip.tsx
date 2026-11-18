import { AUTO_NEVER, AUTO_SESSIONS, AUTO_SPANS, cycled, liveMode, MODE_WORDS, modeLabel, modeTip, spanOf, untilOf, type ChatMode, type ChatModeName } from "@kos/shared";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from "react";
import { createPortal } from "react-dom";

import { BoltIcon, CheckIcon, ChevronDown, HandIcon } from "./icons.js";
import { Switch } from "./kit.js";
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
 * The chat's mode in the composer: Ask or Auto, a press (or Shift+Tab in the
 * box) to cycle, and a menu for how long Auto lasts, whether it starts
 * sessions, and what it never covers. Lit in Auto, and beating while a turn
 * runs under it. The harness decides what Auto lets through; this only sets it.
 */
export function ModeChip({ mode, onChange, running = false, disabled = false }: { mode: ChatMode; onChange: (mode: ChatMode) => void; running?: boolean; disabled?: boolean }): ReactElement {
  const now = useNow(typeof mode.until === "number");
  const live = liveMode(mode, now);
  const [open, setOpen] = useState(false);
  const chip = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [spot, setSpot] = useState<{ left: number; bottom: number } | null>(null);
  useDismiss(open, () => setOpen(false), { inside: [chip, menu] });

  // Above the chip, inside the window side to side: the side panel is narrow and the chip sits mid-row.
  useLayoutEffect(() => {
    if (!open) return;
    const at = chip.current?.getBoundingClientRect();
    const width = menu.current?.offsetWidth ?? 0;
    if (!at) return;
    setSpot({ left: Math.max(8, Math.min(at.left, window.innerWidth - width - 8)), bottom: window.innerHeight - at.top + 6 });
  }, [open]);

  const Icon = ICON[live.mode];
  const span = spanOf(live);
  const set = (next: ChatMode): void => onChange(next);
  return (
    <span ref={chip} className="mode-chip" data-mode={live.mode} data-running={(running && live.mode === "auto") || undefined}>
      <button type="button" className="mode-chip-main" disabled={disabled} title={modeTip(live, now)} aria-label={`Mode: ${modeLabel(live, now)}. Press to change.`} onClick={() => set(cycled(live))}>
        <Icon size={12} />
        <span>{modeLabel(live, now)}</span>
      </button>
      <button type="button" className="mode-chip-more" disabled={disabled} aria-label="Mode options" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <ChevronDown size={10} title="" />
      </button>
      {open &&
        createPortal(
          <div ref={menu} className="mode-menu kos-pop" role="menu" style={spot ? { left: spot.left, bottom: spot.bottom } : { visibility: "hidden" }}>
            {(["ask", "auto"] as const).map((name) => {
              const Mark = ICON[name];
              return (
                <button key={name} type="button" role="menuitemradio" aria-checked={live.mode === name} className="mode-menu-row" onClick={() => set(name === "ask" ? { mode: "ask" } : { mode: "auto", ...(live.sessions ? { sessions: true } : {}) })}>
                  <Mark size={13} />
                  <span className="line-text line-text--wrap">
                    <strong>{MODE_WORDS[name].label}</strong>
                    <span>{MODE_WORDS[name].does}</span>
                  </span>
                  {live.mode === name && <CheckIcon size={13} title="" />}
                </button>
              );
            })}
            <div className="mode-menu-head label">Auto lasts</div>
            {AUTO_SPANS.map((s) => (
              <button
                key={s.id}
                type="button"
                role="menuitemradio"
                aria-checked={live.mode === "auto" && span === s.id}
                className="mode-menu-row mode-menu-row--span"
                onClick={() => {
                  const until = untilOf(s.id, Date.now());
                  set({ mode: "auto", ...(until !== undefined ? { until } : {}), ...(live.sessions ? { sessions: true } : {}) });
                }}
              >
                <span className="mode-menu-span">{s.label}</span>
                {live.mode === "auto" && span === s.id && <CheckIcon size={13} title="" />}
              </button>
            ))}
            <label className="mode-menu-switch">
              <span className="line-text line-text--wrap">
                <strong>{AUTO_SESSIONS.label}</strong>
                <span>{AUTO_SESSIONS.hint}</span>
              </span>
              <Switch label={AUTO_SESSIONS.label} on={live.sessions === true} disabled={live.mode !== "auto"} onChange={(on) => set(withSessions(live, on))} />
            </label>
            <div className="mode-menu-head label">Auto never covers</div>
            <ul className="mode-menu-never">
              {AUTO_NEVER.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>,
          document.body,
        )}
    </span>
  );
}
