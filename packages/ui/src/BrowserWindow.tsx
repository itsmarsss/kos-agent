import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";

import { api } from "./api.js";
import { keyMessages, mouseMessage, toViewport, wheelMessage, type BrowserInputMessage } from "./browserinput.js";
import { EDGE, EDGES, clampBox, cornerBox, readBox, resizedBox, saveBox, type Box, type Edge, type MinSize } from "./floatbox.js";
import { StatusDot } from "./StatusDot.js";

/**
 * KOS's browser, in a window over the page.
 *
 * One Chrome, a tab per agent. The strip under the bar lists the tabs and
 * whose each is; the one you pick is streamed as it changes, so you see
 * what that agent sees as it sees it: for the fun of it, to catch it doing
 * something it should not, and to know what a reply was looking at. Take
 * over, and your mouse and keys go to that tab instead; let go, and the
 * agent carries on. The window floats and remembers its place like the
 * quick-question one.
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
  configured: boolean;
  chrome: "stopped" | "starting" | "running";
  attached: boolean;
  tabs: BrowserTab[];
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
const MIN: MinSize = { width: 360, height: 260 };

function sendInput(tab: string, message: BrowserInputMessage): void {
  void api.browserInput(tab, { ...message }).catch(() => {
    /* the stream tells the status; a lost click is not worth a toast */
  });
}

/** A tab's name in the strip: whose it is, then what it shows. */
function tabLabel(t: BrowserTab, titleFor: (conversationId: string) => string | undefined): { who: string; what: string } {
  const who = t.owner ? (titleFor(t.owner) ?? t.owner) : "";
  let what = t.title;
  if (!what) {
    try {
      what = t.url && t.url !== "about:blank" ? new URL(t.url).host : "blank";
    } catch {
      what = t.url || "blank";
    }
  }
  return { who, what };
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
  /** A conversation's title, for the strip. */
  titleFor?: (conversationId: string) => string | undefined;
}

export function BrowserWindow({ open, onClose, doing, prefer, titleFor = () => undefined, handoffs = [], onDecide }: BrowserWindowProps): ReactElement | null {
  /** A tab picked by hand; with follow on, the working agent's tab wins. */
  const [chosen, setChosen] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  /** The tab shown: the chosen one while it exists, else the working agent's, else the first that is someone's. */
  const [tab, setTab] = useState<string | null>(null);
  const live = useBrowserLive(open, tab);
  const [box, setBox] = useState<Box>(() => readBox(BOX_KEY, MIN, () => cornerBox(720, 520)));
  const boxRef = useRef(box);
  boxRef.current = box;
  const [driving, setDriving] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const shell = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const resize = useRef<{ edge: Edge; x: number; y: number; box: Box } | null>(null);
  const frameSize = useRef({ width: 0, height: 0 });

  // Which tab to show, settled whenever the tabs or the working agent change.
  useEffect(() => {
    const tabs = live.tabs;
    const has = (id: string | null): boolean => !!id && tabs.some((t) => t.id === id);
    const preferred = prefer ? (tabs.find((t) => t.owner === prefer)?.id ?? null) : null;
    const next = follow && preferred ? preferred : has(chosen) ? chosen : (preferred ?? tabs.find((t) => t.owner)?.id ?? tabs[0]?.id ?? null);
    if (next !== tab) setTab(next);
  }, [live.tabs, prefer, chosen, tab, follow]);

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

  if (!open) return null;

  const status = live.status;
  const current = live.tabs.find((t) => t.id === tab) ?? null;
  const state = live.lost || !status || !status.configured ? "off" : live.frame && !live.gone ? "working" : status.attached ? "on" : "off";
  const label = live.lost
    ? "stream lost"
    : !status
      ? "connecting"
      : !status.configured
        ? "no browser engine configured"
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
          <span className="browserwin-url" title={url}>
            {url || (current ? "Blank page" : "Browser")}
          </span>
          {driving ? (
            <span className="browserwin-doing browserwin-doing--you">you have the wheel{owner ? ` on ${owner}'s tab` : ""}</span>
          ) : doing ? (
            <span className="browserwin-doing">{doing}</span>
          ) : owner ? (
            <span className="browserwin-doing">{owner}</span>
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
      {live.tabs.length > 0 && (
        <div className="browserwin-tabs" role="tablist" aria-label="Browser tabs">
          <button
            type="button"
            className={`browserwin-follow${follow ? " is-on" : ""}`}
            aria-pressed={follow}
            title={follow ? "Following whoever is working; click to pin the tab you chose" : "Follow whoever is working"}
            onClick={() => setFollow((v) => !v)}
          >
            {follow ? "Following" : "Pinned"}
          </button>
          {live.tabs.map((t) => {
            const { who, what } = tabLabel(t, titleFor);
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={t.id === tab}
                className={`browserwin-tab${t.id === tab ? " is-active" : ""}${t.owner ? "" : " browserwin-tab--stray"}`}
                title={t.url}
                onClick={() => {
                  setChosen(t.id);
                  setFollow(false);
                  setTab(t.id);
                }}
              >
                {who && <span className="browserwin-tab-who">{who}</span>}
                <span className="browserwin-tab-what">{what}</span>
              </button>
            );
          })}
        </div>
      )}
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
              : status && !status.configured
                ? "No browser engine is set up. Add the browser under Settings › MCP servers."
                : live.gone
                  ? "That tab closed. Pick another above."
                  : !current
                    ? "No tab open yet. One appears here the moment an agent opens a page."
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
