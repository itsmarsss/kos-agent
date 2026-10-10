import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";

import { api } from "./api.js";
import { keyMessages, mouseMessage, toViewport, wheelMessage, type BrowserInputMessage } from "./browserinput.js";
import { EDGES, clampBox, cornerBox, readBox, resizedBox, saveBox, type Box, type Edge, type MinSize } from "./floatbox.js";
import { StatusDot } from "./StatusDot.js";

/**
 * KOS's browser, in a window over the page.
 *
 * Frames arrive as KOS browses, so you see what it sees as it sees it: for
 * the fun of it, to catch it doing something it should not, and to know what
 * a reply was looking at. Take over, and your mouse and keys go to the page
 * instead; let go, and KOS carries on. The window floats and remembers its
 * place like the quick-question one.
 */

export interface BrowserFrame {
  seq: number;
  data: string;
  width: number;
  height: number;
  at: number;
}

export interface BrowserStatus {
  configured: boolean;
  attached: boolean;
  socket?: "none" | "connecting" | "open";
  received?: number;
  connected: boolean;
  screencasting: boolean;
  url?: string;
  viewport?: { width: number; height: number };
}

type LiveEvent = { type: "frame"; frame: BrowserFrame } | { type: "status"; status: BrowserStatus } | { type: "url"; url: string };

export interface BrowserLiveState {
  status: BrowserStatus | null;
  frame: BrowserFrame | null;
  url: string;
  /** The stream itself is down (not the browser): nothing can be shown. */
  lost: boolean;
}

const IDLE: BrowserLiveState = { status: null, frame: null, url: "", lost: false };

/** The live view's feed, open only while `on`. */
export function useBrowserLive(on: boolean): BrowserLiveState {
  const [state, setState] = useState<BrowserLiveState>(IDLE);
  useEffect(() => {
    if (!on) {
      setState(IDLE);
      return;
    }
    const source = new EventSource("/api/browser/live");
    source.onmessage = (message) => {
      let event: LiveEvent;
      try {
        event = JSON.parse(message.data as string) as LiveEvent;
      } catch {
        return;
      }
      setState((cur) => {
        if (event.type === "frame") return { ...cur, frame: event.frame, lost: false };
        if (event.type === "status") return { ...cur, status: event.status, url: event.status.url ?? cur.url, lost: false };
        return { ...cur, url: event.url };
      });
    };
    source.onerror = () => setState((cur) => ({ ...cur, lost: true }));
    return () => source.close();
  }, [on]);
  return state;
}

const BOX_KEY = "kos.browser.box";
const MIN: MinSize = { width: 360, height: 260 };

function sendInput(message: BrowserInputMessage): void {
  void api.browserInput({ ...message }).catch(() => {
    /* the stream told the status; a lost click is not worth a toast */
  });
}

export interface BrowserWindowProps {
  open: boolean;
  onClose: () => void;
  /** What KOS is doing with it right now, if anything, for the title line. */
  doing?: string;
}

export function BrowserWindow({ open, onClose, doing }: BrowserWindowProps): ReactElement | null {
  const live = useBrowserLive(open);
  const [box, setBox] = useState<Box>(() => readBox(BOX_KEY, MIN, () => cornerBox(720, 520)));
  const boxRef = useRef(box);
  boxRef.current = box;
  const [driving, setDriving] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const resize = useRef<{ edge: Edge; x: number; y: number; box: Box } | null>(null);
  const frameSize = useRef({ width: 0, height: 0 });

  useEffect(() => {
    const onResize = (): void => setBox((b) => clampBox(b, MIN));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Each frame is drawn to fit, centred, on a canvas the size of the body.
  useEffect(() => {
    const el = canvas.current;
    const frame = live.frame;
    if (!el || !frame) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      frameSize.current = { width: frame.width || img.naturalWidth, height: frame.height || img.naturalHeight };
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (el.width !== w || el.height !== h) {
        el.width = w;
        el.height = h;
      }
      const ctx = el.getContext("2d");
      if (!ctx) return;
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
  }, [live.frame, box.width, box.height]);

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
  const state = live.lost || !status || !status.configured ? "off" : status.screencasting ? "working" : status.connected ? "on" : "off";
  const label = live.lost
    ? "stream lost"
    : !status
      ? "connecting"
      : !status.configured
        ? "no browser engine configured"
        : status.socket === "connecting"
          ? "connecting to the browser"
          : status.screencasting
            ? "live"
            : status.connected
              ? "browser open, nothing moving"
              : "no browser open";
  const url = live.url || status?.url || "";

  return (
    <div className={`browserwin${driving ? " is-driving" : ""}`} role="dialog" aria-label="Browser" style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
      <div className="browserwin-head" onPointerDown={onDragStart} onPointerMove={onDragMove} onPointerUp={onDragEnd} onPointerCancel={onDragEnd}>
        <StatusDot state={state} label={label} />
        <span className="browserwin-title">
          <span className="browserwin-url" title={url}>
            {url || "Browser"}
          </span>
          {doing && !driving && <span className="browserwin-doing">{doing}</span>}
          {driving && <span className="browserwin-doing browserwin-doing--you">you have the wheel</span>}
        </span>
        <span className="browserwin-acts">
          <button type="button" className={`btn btn--sm${driving ? " btn--primary" : ""}`} aria-pressed={driving} onClick={() => setDriving((v) => !v)} title={driving ? "Give the page back to KOS" : "Click and type in the page yourself"}>
            {driving ? "Let go" : "Take over"}
          </button>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </span>
      </div>
      <div className="browserwin-body">
        <canvas
          ref={canvas}
          className="browserwin-canvas"
          tabIndex={driving ? 0 : -1}
          onPointerDown={(e) => {
            if (!driving) return;
            e.currentTarget.focus();
            sendInput(mouseMessage("mousePressed", place(e), e));
          }}
          onPointerUp={(e) => {
            if (driving) sendInput(mouseMessage("mouseReleased", place(e), e));
          }}
          onPointerMove={(e) => {
            if (driving) sendInput(mouseMessage("mouseMoved", place(e), e));
          }}
          onWheel={(e) => {
            if (!driving) return;
            e.preventDefault();
            sendInput(wheelMessage(place(e), e));
          }}
          onKeyDown={(e) => {
            if (!driving) return;
            e.preventDefault();
            for (const m of keyMessages("keyDown", e)) sendInput(m);
          }}
          onKeyUp={(e) => {
            if (!driving) return;
            e.preventDefault();
            for (const m of keyMessages("keyUp", e)) sendInput(m);
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
                ? "No browser engine is set up. Add agent-browser under Settings › MCP servers."
                : status && !status.connected
                  ? "Nothing open yet. The page appears here the moment KOS opens one."
                  : "Waiting for the first frame…"}
          </p>
        )}
      </div>
      {EDGES.map((edge) => (
        <div key={edge} className={`browserwin-edge browserwin-edge--${edge}`} onPointerDown={onResizeStart(edge)} onPointerMove={onResizeMove} onPointerUp={onResizeEnd} onPointerCancel={onResizeEnd} />
      ))}
    </div>
  );
}
