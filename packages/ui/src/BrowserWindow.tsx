import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";

import { tabName, toAddress } from "./address.js";
import { api } from "./api.js";
import { keyMessages, mouseMessage, toViewport, wheelMessage, type BrowserInputMessage } from "./browserinput.js";
import { EDGE, EDGES, clampBox, cornerBox, readBox, resizedBox, saveBox, type Box, type Edge, type MinSize } from "./floatbox.js";
import { StatusDot } from "./StatusDot.js";

/**
 * KOS's browser, in a window over the page.
 *
 * One Chrome, a tab per agent, and tabs of your own. The strip under the
 * bar lists the tabs and whose each is; the one you pick is streamed as it
 * changes, so you see what that agent sees as it sees it: for the fun of
 * it, to catch it doing something it should not, and to know what a reply
 * was looking at. The address bar under the strip is yours: an address or
 * a search, back, forward, reload, a new tab, a closed one. Take over, and
 * your mouse and keys go to the page too; let go, and the agent carries
 * on. The window floats and remembers its place like the quick-question
 * one.
 */

export interface BrowserFrame {
  seq: number;
  data: string;
  width: number;
  height: number;
  at: number;
}

export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  owner?: string;
}

export interface BrowserStatus {
  chrome: "stopped" | "starting" | "running";
  attached: boolean;
  tabs: BrowserTab[];
  /** Where words typed in the address bar go, with %s for them. */
  search: string;
}

type LiveEvent =
  | { type: "status"; status: BrowserStatus }
  | { type: "tabs"; tabs: BrowserTab[] }
  | { type: "frame"; tab: string; frame: BrowserFrame }
  | { type: "gone"; tab: string };

export interface BrowserLiveState {
  status: BrowserStatus | null;
  tabs: BrowserTab[];
  /** The newest frame of the watched tab. */
  frame: BrowserFrame | null;
  /** The watched tab closed. */
  gone: boolean;
  /** The stream itself is down (not the browser): nothing can be shown. */
  lost: boolean;
}

const IDLE: BrowserLiveState = { status: null, tabs: [], frame: null, gone: false, lost: false };

/** The live feed, open while `on`; frames for `tab` when one is named. */
export function useBrowserLive(on: boolean, tab: string | null): BrowserLiveState {
  const [state, setState] = useState<BrowserLiveState>(IDLE);
  // Nothing streams to a dashboard nobody is looking at: the feed closes
  // while this tab is hidden and opens again when it is back.
  const [shown, setShown] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  useEffect(() => {
    const onChange = (): void => setShown(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  useEffect(() => {
    if (!on) {
      setState(IDLE);
      return;
    }
    if (!shown) return;
    setState((cur) => ({ ...cur, frame: null, gone: false }));
    const source = new EventSource(`/api/browser/live${tab ? `?tab=${encodeURIComponent(tab)}` : ""}`);
    source.onmessage = (message) => {
      let event: LiveEvent;
      try {
        event = JSON.parse(message.data as string) as LiveEvent;
      } catch {
        return;
      }
      setState((cur) => {
        if (event.type === "frame") return event.tab === tab ? { ...cur, frame: event.frame, lost: false } : cur;
        if (event.type === "status") return { ...cur, status: event.status, tabs: event.status.tabs, lost: false };
        if (event.type === "tabs") return { ...cur, tabs: event.tabs };
        return event.tab === tab ? { ...cur, gone: true } : cur;
      });
    };
    source.onerror = () => setState((cur) => ({ ...cur, lost: true }));
    return () => source.close();
  }, [on, tab, shown]);
  return state;
}

const BOX_KEY = "kos.browser.box";
const MIN: MinSize = { width: 360, height: 300 };
const DEFAULT_SEARCH = "https://duckduckgo.com/?q=%s";

function sendInput(tab: string, message: BrowserInputMessage): void {
  void api.browserInput(tab, { ...message }).catch(() => {
    /* the stream tells the status; a lost click is not worth a toast */
  });
}

/** A tab's name in the strip: whose it is, then what it shows. */
function tabLabel(t: BrowserTab, titleFor: (conversationId: string) => string | undefined): { who: string; what: string } {
  return { who: t.owner ? (titleFor(t.owner) ?? t.owner) : "", what: tabName(t) === "blank tab" ? "blank" : tabName(t) };
}

export interface Handoff {
  id: number;
  conversationId: string | null;
  reason: string;
}

export interface BrowserWindowProps {
  open: boolean;
  onClose: () => void;
  /** Agents waiting for the owner's hands on their tab. */
  handoffs?: Handoff[];
  onDecide?: (id: number, approved: boolean) => void;
  /** What KOS is doing with it right now, if anything, for the title line. */
  doing?: string;
  /** The conversation working right now: its tab is the one to show first. */
  prefer?: string;
  /** A tab asked for from outside, as a chip in a chat is: shown, and pinned. */
  pick?: { tab: string; n: number };
  /** A conversation's title, for the strip. */
  titleFor?: (conversationId: string) => string | undefined;
}

export function BrowserWindow({ open, onClose, doing, prefer, pick, titleFor = () => undefined, handoffs = [], onDecide }: BrowserWindowProps): ReactElement | null {
  /** A tab picked by hand; with follow on, the working agent's tab wins. */
  const [chosen, setChosen] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  /** The tab shown: the chosen one while it exists, else the working agent's, else the first that is someone's. */
  const [tab, setTab] = useState<string | null>(null);
  const live = useBrowserLive(open, tab);
  const [box, setBox] = useState<Box>(() => readBox(BOX_KEY, MIN, () => cornerBox(720, 560)));
  const boxRef = useRef(box);
  boxRef.current = box;
  const [driving, setDriving] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  /** What is in the address bar while it is being edited; null shows the tab's own address. */
  const [typed, setTyped] = useState<string | null>(null);
  const shell = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const address = useRef<HTMLInputElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const resize = useRef<{ edge: Edge; x: number; y: number; box: Box } | null>(null);
  const frameSize = useRef({ width: 0, height: 0 });

  /** Show one tab, and keep showing it until another is picked. */
  const pin = useCallback((id: string): void => {
    setChosen(id);
    setFollow(false);
    setTab(id);
  }, []);

  // Which tab to show, settled whenever the tabs or the working agent change.
  useEffect(() => {
    const tabs = live.tabs;
    const has = (id: string | null): boolean => !!id && tabs.some((t) => t.id === id);
    const preferred = prefer ? (tabs.find((t) => t.owner === prefer)?.id ?? null) : null;
    const next = follow && preferred ? preferred : has(chosen) ? chosen : (preferred ?? tabs.find((t) => t.owner)?.id ?? tabs[0]?.id ?? null);
    if (next !== tab) setTab(next);
  }, [live.tabs, prefer, chosen, tab, follow]);

  // A tab asked for from outside: shown, pinned.
  useEffect(() => {
    if (pick) pin(pick.tab);
  }, [pick, pin]);

  // The address bar shows the tab it is on; an edit is dropped on a change of tab.
  useEffect(() => setTyped(null), [tab]);

  useEffect(() => {
    const onResize = (): void => setBox((b) => clampBox(b, MIN));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const onChange = (): void => setFullscreen(document.fullscreenElement === shell.current && shell.current !== null);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggleFullscreen = (): void => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void shell.current?.requestFullscreen().catch(() => {});
  };
  const [, bump] = useState(0);
  useEffect(() => {
    if (!maximized) return;
    const onResize = (): void => bump((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [maximized]);

  // Each frame is drawn to fit, centred, at the screen's own pixel density.
  useEffect(() => {
    const el = canvas.current;
    const frame = live.frame;
    if (!el || !frame) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      frameSize.current = { width: frame.width || img.naturalWidth, height: frame.height || img.naturalHeight };
      const dpr = window.devicePixelRatio || 1;
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
        el.width = Math.round(w * dpr);
        el.height = Math.round(h * dpr);
      }
      const ctx = el.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      const scale = Math.min(w / img.naturalWidth, h / img.naturalHeight);
      const dw = img.naturalWidth * scale;
      const dh = img.naturalHeight * scale;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    };
    img.src = `data:image/jpeg;base64,${frame.data}`;
    return () => {
      cancelled = true;
    };
  }, [live.frame, box.width, box.height, maximized, fullscreen]);

  // A new tab starts blank until its first frame.
  useEffect(() => {
    const el = canvas.current;
    if (!el || live.frame) return;
    el.getContext("2d")?.clearRect(0, 0, el.width, el.height);
  }, [tab, live.frame]);

  const place = useCallback((e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const el = canvas.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return toViewport({ x: e.clientX - r.left, y: e.clientY - r.top }, { width: r.width, height: r.height }, frameSize.current);
  }, []);

  const onDragStart = (e: ReactPointerEvent<HTMLElement>): void => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, left: boxRef.current.left, top: boxRef.current.top };
  };
  const onDragMove = (e: ReactPointerEvent<HTMLElement>): void => {
    const d = drag.current;
    if (!d) return;
    setBox((b) => clampBox({ ...b, left: d.left + (e.clientX - d.x), top: d.top + (e.clientY - d.y) }, MIN));
  };
  const onDragEnd = (e: ReactPointerEvent<HTMLElement>): void => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const final = clampBox({ ...boxRef.current, left: d.left + (e.clientX - d.x), top: d.top + (e.clientY - d.y) }, MIN);
    setBox(final);
    saveBox(BOX_KEY, final);
  };
  const onResizeStart = (edge: Edge) => (e: ReactPointerEvent<HTMLElement>): void => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    resize.current = { edge, x: e.clientX, y: e.clientY, box: boxRef.current };
  };
  const onResizeMove = (e: ReactPointerEvent<HTMLElement>): void => {
    const r = resize.current;
    if (!r) return;
    setBox(resizedBox(r.box, r.edge, e.clientX - r.x, e.clientY - r.y, MIN));
  };
  const onResizeEnd = (e: ReactPointerEvent<HTMLElement>): void => {
    const r = resize.current;
    if (!r) return;
    resize.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const final = resizedBox(r.box, r.edge, e.clientX - r.x, e.clientY - r.y, MIN);
    setBox(final);
    saveBox(BOX_KEY, final);
  };

  /** A tab of your own, shown and ready to be typed into. */
  const newTab = (url?: string): void => {
    void api
      .browserNewTab(url)
      .then((r) => {
        pin(r.tab);
        if (!url) requestAnimationFrame(() => address.current?.focus());
      })
      .catch(() => undefined);
  };
  /** Enter in the address bar: the tab goes there, or a new tab does when there is none. */
  const go = (): void => {
    const target = toAddress(typed ?? "", live.status?.search ?? DEFAULT_SEARCH);
    setTyped(null);
    if (!target) return;
    if (tab) void api.browserNavigate(tab, { url: target }).catch(() => undefined);
    else newTab(target);
    address.current?.blur();
  };
  const step = (action: "back" | "forward" | "reload"): void => {
    if (tab) void api.browserNavigate(tab, { action }).catch(() => undefined);
  };
  const closeTab = (id: string): void => {
    void api.browserCloseTab(id).catch(() => undefined);
  };

  if (!open) return null;

  const status = live.status;
  const current = live.tabs.find((t) => t.id === tab) ?? null;
  const ready = !!status && !live.lost;
  const state = live.lost || !status ? "off" : live.frame && !live.gone ? "working" : status.attached ? "on" : "off";
  const label = live.lost
    ? "stream lost"
    : !status
      ? "connecting"
      : status.chrome !== "running"
        ? "browser not started"
        : live.gone
          ? "that tab closed"
          : live.frame
            ? "live"
            : current
              ? "waiting for the first frame"
              : "no tab open";
  const url = current?.url && current.url !== "about:blank" ? current.url : "";
  const owner = current?.owner ? (titleFor(current.owner) ?? current.owner) : "";
  const placed: Box = maximized ? { left: EDGE, top: EDGE, width: window.innerWidth - EDGE * 2, height: window.innerHeight - EDGE * 2 } : box;
  const frameNote = live.frame ? `${live.frame.width}×${live.frame.height}` : "";
  // The ask that belongs to the tab on screen, else the first one waiting.
  const handoff = handoffs.find((h) => current?.owner && h.conversationId === current.owner) ?? handoffs[0];

  return (
    <div
      ref={shell}
      className={`browserwin${driving ? " is-driving" : ""}${maximized ? " is-max" : ""}${fullscreen ? " is-fullscreen" : ""}`}
      role="dialog"
      aria-label="Browser"
      style={fullscreen ? undefined : { left: placed.left, top: placed.top, width: placed.width, height: placed.height }}
    >
      <div
        className="browserwin-head"
        onPointerDown={maximized || fullscreen ? undefined : onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        onDoubleClick={(e) => {
          if (!(e.target as HTMLElement).closest("button")) setMaximized((v) => !v);
        }}
      >
        <StatusDot state={state} label={label} />
        <span className="browserwin-title">
          <span className="browserwin-name" title={url}>
            {current ? tabName(current) : "Browser"}
          </span>
          {driving ? (
            <span className="browserwin-doing browserwin-doing--you">you have the wheel{owner ? ` on ${owner}'s tab` : ""}</span>
          ) : doing ? (
            <span className="browserwin-doing">{doing}</span>
          ) : owner ? (
            <span className="browserwin-doing">{owner}</span>
          ) : current ? (
            <span className="browserwin-doing">your tab</span>
          ) : null}
        </span>
        <span className="browserwin-acts">
          {frameNote && (
            <span className="browserwin-size" title="Frame size, in the browser's pixels">
              {frameNote}
            </span>
          )}
          <button
            type="button"
            className={`btn btn--sm${driving ? " btn--primary" : ""}`}
            aria-pressed={driving}
            disabled={!current}
            onClick={() => setDriving((v) => !v)}
            title={driving ? "Give the tab back to the agent" : "Click and type in this tab yourself"}
          >
            {driving ? "Let go" : "Take over"}
          </button>
          <button type="button" className="icon-btn" aria-label={maximized ? "Restore size" : "Maximize"} aria-pressed={maximized} title={maximized ? "Back to the window's own size" : "Fill the page (double-click the bar does too)"} onClick={() => setMaximized((v) => !v)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {maximized ? <path d="M9 3H3v6M15 21h6v-6M3 3l7 7M21 21l-7-7" /> : <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />}
            </svg>
          </button>
          <button type="button" className="icon-btn" aria-label={fullscreen ? "Leave full screen" : "Full screen"} aria-pressed={fullscreen} title={fullscreen ? "Leave full screen (Esc)" : "The whole screen"} onClick={toggleFullscreen}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />
            </svg>
          </button>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </span>
      </div>
      <div className="browserwin-tabs" role="tablist" aria-label="Browser tabs">
        {live.tabs.length > 0 && (
          <button
            type="button"
            className={`browserwin-follow${follow ? " is-on" : ""}`}
            aria-pressed={follow}
            title={follow ? "Following whoever is working; click to pin the tab you chose" : "Follow whoever is working"}
            onClick={() => setFollow((v) => !v)}
          >
            {follow ? "Following" : "Pinned"}
          </button>
        )}
        {live.tabs.map((t) => {
          const { who, what } = tabLabel(t, titleFor);
          const active = t.id === tab;
          return (
            <span key={t.id} className={`browserwin-tab${active ? " is-active" : ""}${t.owner ? "" : " browserwin-tab--yours"}`} title={t.url}>
              <button type="button" role="tab" aria-selected={active} className="browserwin-tab-pick" onClick={() => pin(t.id)}>
                {who && <span className="browserwin-tab-who">{who}</span>}
                <span className="browserwin-tab-what">{what}</span>
              </button>
              <button type="button" className="browserwin-tab-x" aria-label={`Close ${what}`} title="Close this tab" onClick={() => closeTab(t.id)}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </span>
          );
        })}
        <button type="button" className="icon-btn browserwin-new" aria-label="New tab" title="A tab of your own" disabled={!ready} onClick={() => newTab()}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>
      <div className="browserwin-nav">
        <button type="button" className="icon-btn" aria-label="Back" title="Back" disabled={!current} onClick={() => step("back")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </button>
        <button type="button" className="icon-btn" aria-label="Forward" title="Forward" disabled={!current} onClick={() => step("forward")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 5l7 7-7 7" />
          </svg>
        </button>
        <button type="button" className="icon-btn" aria-label="Reload" title="Reload" disabled={!current} onClick={() => step("reload")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />
          </svg>
        </button>
        <input
          ref={address}
          className="browserwin-address"
          type="text"
          aria-label="Address or search"
          placeholder={current ? "Address or search" : "Address or search, in a new tab"}
          value={typed ?? url}
          disabled={!ready}
          spellCheck={false}
          autoComplete="off"
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              go();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setTyped(null);
              e.currentTarget.blur();
            }
          }}
        />
      </div>
      {handoff && onDecide && (
        <div className="browserwin-handoff" role="status">
          <span className="browserwin-handoff-text">
            <strong>{handoff.conversationId ? (titleFor(handoff.conversationId) ?? "An agent") : "An agent"} needs your hands.</strong> {handoff.reason}
          </span>
          <span className="browserwin-handoff-acts">
            {!driving && (
              <button type="button" className="btn btn--sm btn--primary" onClick={() => setDriving(true)}>
                Take over
              </button>
            )}
            <button
              type="button"
              className="btn btn--sm btn--ok"
              onClick={() => {
                setDriving(false);
                onDecide(handoff.id, true);
              }}
            >
              Done
            </button>
            <button type="button" className="btn btn--sm" onClick={() => onDecide(handoff.id, false)}>
              Can't
            </button>
          </span>
        </div>
      )}
      <div className="browserwin-body">
        <canvas
          ref={canvas}
          className="browserwin-canvas"
          tabIndex={driving ? 0 : -1}
          onPointerDown={(e) => {
            if (!driving || !tab) return;
            e.currentTarget.focus();
            sendInput(tab, mouseMessage("mousePressed", place(e), e));
          }}
          onPointerUp={(e) => {
            if (driving && tab) sendInput(tab, mouseMessage("mouseReleased", place(e), e));
          }}
          onPointerMove={(e) => {
            if (driving && tab) sendInput(tab, mouseMessage("mouseMoved", place(e), e));
          }}
          onWheel={(e) => {
            if (!driving || !tab) return;
            e.preventDefault();
            sendInput(tab, wheelMessage(place(e), e));
          }}
          onKeyDown={(e) => {
            if (!driving || !tab) return;
            e.preventDefault();
            for (const m of keyMessages("keyDown", e)) sendInput(tab, m);
          }}
          onKeyUp={(e) => {
            if (!driving || !tab) return;
            e.preventDefault();
            for (const m of keyMessages("keyUp", e)) sendInput(tab, m);
          }}
          onContextMenu={(e) => {
            if (driving) e.preventDefault();
          }}
        />
        {!live.frame && (
          <p className="browserwin-empty">
            {live.lost
              ? "The live stream dropped. It comes back on its own when the browser does."
              : live.gone
                ? "That tab closed. Pick another above."
                : !current
                  ? "No tab open yet. Type an address above, press +, or wait for an agent to open a page."
                  : "Waiting for the first frame…"}
          </p>
        )}
      </div>
      {!maximized && !fullscreen && EDGES.map((edge) => (
        <div key={edge} className={`browserwin-edge browserwin-edge--${edge}`} onPointerDown={onResizeStart(edge)} onPointerMove={onResizeMove} onPointerUp={onResizeEnd} onPointerCancel={onResizeEnd} />
      ))}
    </div>
  );
}
