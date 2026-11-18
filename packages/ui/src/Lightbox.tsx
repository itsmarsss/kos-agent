import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactElement, type ReactNode, type WheelEvent } from "react";
import { AnimatePresence, m } from "motion/react";

import { ChevronLeft, ChevronRight, CloseIcon, CopyIcon, DownloadIcon, ease, IconButton, PictureViewer, spring, useDismiss, useFocusTrap } from "@kos/kit";

/** One picture the viewer shows: where it is, the step's words, and when. */
export interface Shown {
  src: string;
  caption?: string;
  at?: number;
}

/** The pictures a gallery holds, in the order they stand on the page. */
function picturesIn(root: HTMLElement): { pictures: Shown[]; buttons: HTMLElement[] } {
  const buttons = [...root.querySelectorAll<HTMLElement>("[data-picture]")];
  const pictures = buttons.map((b) => {
    const at = Number(b.dataset["at"]);
    return { src: b.dataset["picture"]!, ...(b.dataset["caption"] ? { caption: b.dataset["caption"] } : {}), ...(Number.isFinite(at) && at > 0 ? { at } : {}) };
  });
  return { pictures, buttons };
}

/**
 * Where the step pictures under it open: a press on one shows it in the
 * Lightbox, with every other picture in the gallery a step away. The chat
 * thread is one gallery, so a turn's pictures are walked through in order.
 */
export function PictureGallery({ children }: { children: ReactNode }): ReactElement {
  const root = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<{ pictures: Shown[]; index: number } | null>(null);
  const view = useCallback((from: HTMLElement) => {
    if (!root.current) return;
    const { pictures, buttons } = picturesIn(root.current);
    setShown({ pictures, index: Math.max(0, buttons.indexOf(from)) });
  }, []);
  return (
    <PictureViewer.Provider value={view}>
      <div ref={root} className="picture-gallery">
        {children}
      </div>
      <Lightbox pictures={shown?.pictures ?? []} index={shown?.index ?? null} onIndex={(index) => setShown((s) => (s ? { ...s, index } : s))} onClose={() => setShown(null)} />
    </PictureViewer.Provider>
  );
}

/** How far a picture zooms on a press, and at most by a pinch. */
const ZOOM = 2.5;
const MAX_ZOOM = 6;
/** How far a drag goes before it is a swipe to the next picture, not a press. */
const SWIPE = 60;
const PRESS = 6;

/** What a downloaded picture is called: the step's time, else now. */
export function downloadName(at: number | undefined, now = Date.now()): string {
  const d = new Date(at ?? now);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `kos-step-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`;
}

/**
 * A picture as PNG, which the clipboard takes everywhere: a step's picture
 * is kept as JPEG, which Chrome's clipboard refuses.
 */
async function pngOf(src: string): Promise<Blob> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext("2d")?.drawImage(img, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("no picture"))), "image/png"));
}

/**
 * A zoomed picture moved no further than keeps it over the window's middle:
 * its edge stops at the window's edge, so it cannot be dragged off.
 */
export function clampPan(view: View, width: number, height: number): View {
  const x = ((view.scale - 1) * width) / 2;
  const y = ((view.scale - 1) * height) / 2;
  return { ...view, x: Math.max(-x, Math.min(x, view.x)), y: Math.max(-y, Math.min(y, view.y)) };
}

/** clampPan for the picture as it lies, unscaled. */
function clamped(view: View, img: HTMLElement): View {
  return clampPan(view, img.offsetWidth, img.offsetHeight);
}

export interface View {
  scale: number;
  x: number;
  y: number;
}
const FIT: View = { scale: 1, x: 0, y: 0 };

/**
 * A step's picture over a dimmed page, fitted to the window at its own
 * resolution: its words and time under it, the turn's other pictures a
 * press or an arrow key away ("3 of 8"), a press or a pinch to zoom and a
 * drag to look around a zoomed one, Download and Copy image. Escape or a
 * press outside it closes it, and the focus goes back to the thumbnail. On
 * a phone it fills the screen and a swipe moves through the pictures.
 */
export function Lightbox({ pictures, index, onIndex, onClose }: { pictures: Shown[]; index: number | null; onIndex: (index: number) => void; onClose: () => void }): ReactElement {
  const open = index !== null && pictures[index] !== undefined;
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(FIT);
  const [copied, setCopied] = useState(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ x: number; y: number; view: View; distance: number; moved: number } | null>(null);
  useDismiss(open, onClose, { away: false, scroll: false, resize: false, escape: "dialog" });
  useFocusTrap(box, open);

  const go = (to: number): void => {
    if (index === null || to < 0 || to >= pictures.length) return;
    setView(FIT);
    setCopied(false);
    onIndex(to);
  };
  const picture = index !== null ? pictures[index] : undefined;

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "ArrowRight") go((index ?? 0) + 1);
    else if (e.key === "ArrowLeft") go((index ?? 0) - 1);
    else if (e.key === "+" || e.key === "=") setView((v) => ({ ...v, scale: Math.min(MAX_ZOOM, v.scale * 1.5) }));
    else if (e.key === "-") setView((v) => (v.scale / 1.5 <= 1 ? FIT : { ...v, scale: v.scale / 1.5 }));
    else return;
    e.preventDefault();
  };

  const spread = (): number => {
    const [a, b] = [...pointers.current.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  const down = (e: PointerEvent<HTMLImageElement>): void => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    gesture.current = { x: e.clientX, y: e.clientY, view, distance: spread(), moved: 0 };
  };
  const move = (e: PointerEvent<HTMLImageElement>): void => {
    if (!pointers.current.has(e.pointerId) || !gesture.current) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    g.moved = Math.max(g.moved, Math.hypot(e.clientX - g.x, e.clientY - g.y));
    if (pointers.current.size === 2 && g.distance > 0) {
      setView({ ...g.view, scale: Math.min(MAX_ZOOM, Math.max(1, (g.view.scale * spread()) / g.distance)) });
    } else if (g.view.scale > 1) {
      setView(clamped({ ...g.view, x: g.view.x + e.clientX - g.x, y: g.view.y + e.clientY - g.y }, e.currentTarget));
    }
  };
  const up = (e: PointerEvent<HTMLImageElement>): void => {
    const g = gesture.current;
    const many = pointers.current.size > 1;
    pointers.current.delete(e.pointerId);
    if (!g || many) return;
    gesture.current = null;
    const dx = e.clientX - g.x;
    if (g.view.scale === 1 && Math.abs(dx) > SWIPE && Math.abs(dx) > Math.abs(e.clientY - g.y)) {
      go((index ?? 0) + (dx < 0 ? 1 : -1));
    } else if (g.moved < PRESS) {
      // A press zooms in at the place pressed, and a press on a zoomed picture fits it again.
      if (view.scale > 1) setView(FIT);
      else {
        const r = e.currentTarget.getBoundingClientRect();
        setView(clamped({ scale: ZOOM, x: (r.left + r.width / 2 - e.clientX) * (ZOOM - 1), y: (r.top + r.height / 2 - e.clientY) * (ZOOM - 1) }, e.currentTarget));
      }
    }
  };
  const wheel = (e: WheelEvent<HTMLImageElement>): void => {
    if (!e.ctrlKey && !e.metaKey) return;
    setView((v) => {
      const scale = Math.min(MAX_ZOOM, Math.max(1, v.scale * (e.deltaY < 0 ? 1.1 : 0.9)));
      return scale === 1 ? FIT : { ...v, scale };
    });
  };

  const copy = (): void => {
    if (!picture) return;
    void pngOf(picture.src)
      .then((png) => navigator.clipboard.write([new ClipboardItem({ "image/png": png })]))
      .then(() => setCopied(true), () => undefined);
  };

  return (
    <AnimatePresence>
      {open && picture && (
        <m.div
          ref={box}
          className="lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="Step picture"
          tabIndex={-1}
          onKeyDown={onKeyDown}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={ease}
        >
          {/* A press on the dim, not the picture or its controls, closes it. */}
          <div className="lightbox-dim" onClick={onClose} />
          <div className="lightbox-bar">
            <span className="lightbox-count" aria-live="polite">
              {pictures.length > 1 ? `${index! + 1} of ${pictures.length}` : ""}
            </span>
            <div className="lightbox-actions">
              <a className="icon-btn" href={picture.src} download={downloadName(picture.at)} aria-label="Download" title="Download">
                <DownloadIcon title="" />
              </a>
              <IconButton label={copied ? "Copied" : "Copy image"} onClick={copy}>
                <CopyIcon title="" />
              </IconButton>
              <IconButton label="Close" onClick={onClose}>
                <CloseIcon title="" />
              </IconButton>
            </div>
          </div>
          <div className="lightbox-stage">
            <m.div key={picture.src} className="lightbox-frame" initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} transition={spring}>
            <img
              className={`lightbox-img${view.scale > 1 ? " is-zoomed" : ""}`}
              src={picture.src}
              alt={picture.caption ?? "What this step saw"}
              draggable={false}
              onPointerDown={down}
              onPointerMove={move}
              onPointerUp={up}
              onPointerCancel={() => {
                pointers.current.clear();
                gesture.current = null;
              }}
              onWheel={wheel}
              style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
            />
            </m.div>
          </div>
          {pictures.length > 1 && (
            <>
              <IconButton className="lightbox-prev" label="Previous picture" disabled={index === 0} onClick={() => go(index! - 1)}>
                <ChevronLeft title="" />
              </IconButton>
              <IconButton className="lightbox-next" label="Next picture" disabled={index === pictures.length - 1} onClick={() => go(index! + 1)}>
                <ChevronRight title="" />
              </IconButton>
            </>
          )}
          {(picture.caption || picture.at) && (
            <p className="lightbox-caption">
              {picture.caption}
              {picture.at && <span className="lightbox-time">{new Date(picture.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>}
            </p>
          )}
        </m.div>
      )}
    </AnimatePresence>
  );
}
