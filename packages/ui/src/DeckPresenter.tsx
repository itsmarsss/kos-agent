import { ChevronLeft, ChevronRight, IconButton, PauseIcon, Pill, PlayIcon, RetryIcon, useOverlayScroll } from "@kos/kit";
import type { HtmlPage } from "@kos/shared";
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactElement, type RefObject } from "react";
import { createPortal } from "react-dom";

import type { PageSummary } from "./api.js";
import { clampSlide, clockElapsed, clockRunning, clockWords, followDeck, moveSlide, pauseClock, presenterKey, resetClock, resumeClock, slideAfter, startClock, unfollowed, type Follow } from "./presenter.js";
import { openAudience, presentLink, type PresentLink } from "./presentlink.js";
import { ArtifactPage, type ArtifactHandle, type DeckView } from "./widgets/ArtifactPage.js";

/**
 * The presenter view: the current slide large, the next one smaller, the
 * current slide's notes, an elapsed timer, the place and the controls, over
 * the whole dashboard. The audience window (AudienceWindow.tsx) shows the
 * slide alone, on another screen. The dashboard holds the place and tells
 * every deck frame it: these two, framed as the viewer frames an artifact,
 * and the audience's, over the presentation's channel (presentlink.ts).
 */

/**
 * Keep a deck frame on the slide wanted, as presenter.ts followDeck says;
 * `onMoved` hears the frame moving on its own. A frame that loads again
 * starts over.
 */
export function useFollow(frame: RefObject<ArtifactHandle | null>, view: DeckView | undefined, want: number, onMoved?: (index: number) => void): void {
  const follow = useRef<Follow>(unfollowed);
  useEffect(() => {
    if (!view) {
      follow.current = unfollowed;
      return;
    }
    const s = followDeck(follow.current, want, view.index);
    follow.current = s.follow;
    if (s.go !== undefined) frame.current?.go(s.go);
    if (s.moved !== undefined) onMoved?.(s.moved);
  }, [frame, view, want, onMoved]);
}

/** Where the audience window stands, as the presenter sees it. */
type Audience = "opening" | "open" | "closed";

export interface DeckPresenterProps {
  record: PageSummary;
  page: HtmlPage;
  /** Where the viewer's deck was: the presenter starts there. */
  start: number;
  /** How many slides the viewer's deck said it has, until the presenter's own says. */
  count: number;
  session: string;
  /** The audience window, opened by the owner's press; none when the browser blocked it. */
  audience: Window | null;
  /** Presenting is over, on this slide. */
  onEnd: (index: number) => void;
}

const TICK_MS = 500;
/** How often the presenter looks whether the audience window was closed. */
const WATCH_MS = 1000;

export function DeckPresenter({ record, page, start, count: told, session, audience: opened, onEnd }: DeckPresenterProps): ReactElement {
  const root = useRef<HTMLDivElement>(null);
  const current = useRef<ArtifactHandle>(null);
  const next = useRef<ArtifactHandle>(null);
  const [now, setNow] = useState(() => Date.now());
  const [clock, setClock] = useState(() => startClock(Date.now()));
  const [currentView, setCurrentView] = useState<DeckView>();
  const [nextView, setNextView] = useState<DeckView>();
  const count = currentView?.count || told;
  const [index, setIndex] = useState(() => clampSlide(start, told));
  const after = slideAfter(index, count);
  const place = useRef(index);
  place.current = index;
  const slides = useRef(count);
  slides.current = count;
  // The deck's own count, once it says it, may be fewer than the viewer's.
  useEffect(() => setIndex((i) => clampSlide(i, count)), [count]);

  // The audience window: its handle, and where it stands.
  const win = useRef<Window | null>(opened);
  const [audience, setAudience] = useState<Audience>(opened ? "opening" : "closed");
  const [blocked, setBlocked] = useState(!opened);
  const link = useRef<PresentLink>(null);

  useEffect(() => {
    const l = presentLink(session);
    link.current = l;
    const stop = l.listen((signal) => {
      if (signal.type === "hello") {
        setAudience("open");
        l.post({ type: "go", index: place.current });
      } else if (signal.type === "moved") setIndex(clampSlide(signal.index, slides.current));
    });
    return () => {
      stop();
      l.close();
      link.current = null;
    };
  }, [session]);
  useEffect(() => link.current?.post({ type: "go", index }), [index]);
  // A window the owner closed is closed: there is no event for it in the window that opened it.
  useEffect(() => {
    const watch = setInterval(() => {
      if (win.current?.closed) {
        win.current = null;
        setAudience("closed");
      }
    }, WATCH_MS);
    return () => clearInterval(watch);
  }, []);
  const reopen = (): void => {
    win.current = openAudience(record.id, session);
    setBlocked(!win.current);
    setAudience(win.current ? "opening" : "closed");
  };

  // Ending: the audience window closes with it, whichever way it ends (End, Escape, the dashboard leaving the viewer).
  const finish = useCallback((): void => {
    link.current?.post({ type: "end" });
    win.current?.close();
    win.current = null;
  }, []);
  const end = useCallback((): void => {
    finish();
    onEnd(place.current);
  }, [finish, onEnd]);
  useEffect(() => {
    const el = root.current;
    addEventListener("pagehide", finish);
    return () => {
      removeEventListener("pagehide", finish);
      // Unmounted for good, not the development build's mount run twice, which leaves the view in place.
      if (!el?.isConnected) finish();
    };
  }, [finish]);

  const go = useCallback((move: Parameters<typeof moveSlide>[2]) => setIndex((i) => moveSlide(i, count, move)), [count]);
  const adopt = useCallback((i: number) => setIndex(clampSlide(i, count)), [count]);
  useFollow(current, currentView, index, adopt);
  useFollow(next, nextView, after ?? index);

  // The timer: ticking while it runs.
  const running = clockRunning(clock);
  useEffect(() => {
    if (!running) return;
    const tick = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(tick);
  }, [running]);
  const toggle = (): void => {
    const t = Date.now();
    setNow(t);
    setClock((c) => (clockRunning(c) ? pauseClock(c, t) : resumeClock(c, t)));
  };
  const reset = (): void => {
    const t = Date.now();
    setNow(t);
    setClock((c) => resetClock(c, t));
  };

  // The keys, the dashboard's own while this is open; a control keeps its Space and Enter.
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.key === " " || e.key === "Enter") && (e.target as Element | null)?.closest?.("button, a, input, textarea, select")) return;
      const k = presenterKey(e.key, e.shiftKey);
      if (!k) return;
      e.preventDefault();
      e.stopPropagation();
      if (k === "end") end();
      else go(k);
    };
    addEventListener("keydown", key, true);
    return () => removeEventListener("keydown", key, true);
  }, [end, go]);

  // The view holds the focus while open, the page under it does not scroll, and the focus goes back after.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    root.current?.focus();
    document.documentElement.classList.add("has-presenter");
    return () => {
      document.documentElement.classList.remove("has-presenter");
      before?.focus?.();
    };
  }, []);

  // What went wrong in a slide's frame, said once here and never over the slide.
  const [trouble, setTrouble] = useState<string>();
  const troubled = useCallback((words: string) => setTrouble((was) => was ?? words), []);
  const said = currentView?.said ?? [];
  const notesScroll = useOverlayScroll<HTMLDivElement>();
  const tap = (e: MouseEvent<HTMLDivElement>): void => {
    const r = e.currentTarget.getBoundingClientRect();
    go(e.clientX - r.left < r.width / 3 ? "prev" : "next");
  };

  return createPortal(
    <div className="presenter" ref={root} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`Presenting ${record.title}`}>
      <header className="presenter-head">
        <div className="presenter-title">
          <span className="label">Presenting</span>
          <h2>{record.title}</h2>
        </div>
        <div className="presenter-clock" role="group" aria-label="Elapsed time">
          <span className={`presenter-time${running ? "" : " is-paused"}`} role="timer" aria-live="off">
            {clockWords(clockElapsed(clock, now))}
          </span>
          <IconButton label={running ? "Pause the timer" : "Resume the timer"} onClick={toggle}>
            {running ? <PauseIcon title="" /> : <PlayIcon title="" />}
          </IconButton>
          <IconButton label="Reset the timer" onClick={reset}>
            <RetryIcon title="" />
          </IconButton>
        </div>
        <div className="presenter-acts">
          {trouble && (
            <span className="presenter-trouble" role="alert" title={trouble}>
              {trouble}
            </span>
          )}
          {audience === "open" && <Pill tone="ok">Audience window open</Pill>}
          {audience === "opening" && <Pill>Opening the audience window</Pill>}
          {audience === "closed" && (
            <>
              <Pill tone={blocked ? "warn" : "muted"} title={blocked ? "The browser blocked the window: allow pop-ups for KOS, or present from this screen" : undefined}>
                {blocked ? "Pop-up blocked" : "No audience window"}
              </Pill>
              <button type="button" className="btn btn--ghost btn--sm" onClick={reopen}>
                Open audience window
              </button>
            </>
          )}
          <button type="button" className="btn btn--sm" title="End presenting (Esc)" onClick={end}>
            End
          </button>
        </div>
      </header>
      <div className="presenter-body">
        <section className="presenter-main" aria-label="Current slide">
          <div className="presenter-stage">
            <div className="presenter-slide presenter-slide--current" onClick={tap}>
              <div className="presenter-frame" inert>
                <ArtifactPage ref={current} record={record} page={page} locked presenting onDeck={setCurrentView} onTrouble={troubled} />
              </div>
            </div>
            <nav className="presenter-steer" aria-label="Slides">
              <IconButton label="Previous slide" disabled={index === 0} onClick={() => go("prev")}>
                <ChevronLeft size={16} title="" />
              </IconButton>
              <span className="presenter-count" aria-live="polite">
                Slide {index + 1} of {count}
              </span>
              <IconButton label="Next slide" disabled={after === undefined} onClick={() => go("next")}>
                <ChevronRight size={16} title="" />
              </IconButton>
            </nav>
          </div>
        </section>
        <aside className="presenter-side">
          <section className="presenter-next" aria-label="Next slide">
            <span className="label">{after === undefined ? "Next" : `Next, slide ${after + 1}`}</span>
            <div className="presenter-slide presenter-slide--next" data-end={after === undefined ? "" : undefined}>
              <div className="presenter-frame" inert>
                <ArtifactPage ref={next} record={record} page={page} locked presenting onDeck={setNextView} onTrouble={troubled} />
              </div>
              {after === undefined && <span className="presenter-end">End of the deck</span>}
            </div>
          </section>
          <section className="presenter-notes" aria-label="Notes">
            <span className="label">Notes, slide {index + 1}</span>
            <div className="presenter-notes-body" ref={notesScroll}>
              {said.length ? said.map((line, i) => <p key={i}>{line}</p>) : <p className="presenter-notes-none">No notes for this slide.</p>}
            </div>
          </section>
        </aside>
      </div>
    </div>,
    document.body,
  );
}
