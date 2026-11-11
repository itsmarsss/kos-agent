import { FullscreenIcon } from "@kos/kit";
import type { HtmlPage } from "@kos/shared";
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactElement } from "react";

import { api, type PageSummary } from "./api.js";
import { useFollow } from "./DeckPresenter.js";
import { moveSlide, presenterKey } from "./presenter.js";
import { presentLink, type PresentLink } from "./presentlink.js";
import { ArtifactPage, type ArtifactHandle, type DeckView } from "./widgets/ArtifactPage.js";

/**
 * The audience window: the slide alone, for the screen the room sees. It is
 * the dashboard's own page at `#/audience/<id>/<session>`, drawn without the
 * dashboard around it (main.tsx), and frames the deck as the viewer does
 * (ArtifactPage: the wrapper, the sandboxed srcdoc frames). It moves only as
 * the presenter view tells it over the presentation's channel; a key pressed
 * in it moves its deck, and the presenter follows.
 */
/** How long the mouse rests before the bar and the pointer go. */
const IDLE_MS = 3000;
/** How long a press waits for a second one, which makes it a double-click. */
const DOUBLE_MS = 250;

export function AudienceWindow({ id, session }: { id: string; session: string }): ReactElement {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<ArtifactHandle>(null);
  const link = useRef<PresentLink>(null);
  const [got, setGot] = useState<{ record: PageSummary; page: HtmlPage }>();
  const [error, setError] = useState<string>();
  const [view, setView] = useState<DeckView>();
  const [want, setWant] = useState(0);
  const [full, setFull] = useState(false);

  useEffect(() => {
    let stale = false;
    api.anyPage(id).then(
      (p) => {
        if (stale) return;
        if (p.kind === "html" && p.record.artifactKind === "deck") setGot({ record: p.record, page: p.page });
        else setError("This is not a deck, so it has nothing to present.");
      },
      (err: unknown) => !stale && setError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      stale = true;
    };
  }, [id]);
  useEffect(() => {
    if (got) document.title = `${got.record.title} · Audience`;
  }, [got]);

  useEffect(() => {
    const l = presentLink(session);
    link.current = l;
    const stop = l.listen((signal) => {
      if (signal.type === "go") setWant(signal.index);
      else if (signal.type === "end") window.close();
    });
    // Up: the presenter says where it is.
    l.post({ type: "hello" });
    return () => {
      stop();
      l.close();
      link.current = null;
    };
  }, [session]);

  const moved = useCallback((index: number): void => {
    setWant(index);
    link.current?.post({ type: "moved", index });
  }, []);
  useFollow(frame, view, want, moved);

  useEffect(() => {
    const changed = (): void => setFull(document.fullscreenElement === box.current);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  // Full screen and back, from a press here (the browser gives it to nothing else).
  const fullScreen = useCallback((): void => {
    if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => undefined);
    else void box.current?.requestFullscreen?.().catch(() => undefined);
  }, []);

  // The bar and the pointer go after a while without the mouse moving, and come back when it does.
  const [awake, setAwake] = useState(true);
  const sleep = useRef<ReturnType<typeof setTimeout>>(undefined);
  const stir = useCallback((): void => {
    setAwake(true);
    clearTimeout(sleep.current);
    sleep.current = setTimeout(() => setAwake(false), IDLE_MS);
  }, []);
  useEffect(() => {
    stir();
    return () => clearTimeout(sleep.current);
  }, [stir]);

  // The presenter's keys work here too, for an owner whose hand is on this window, and F for full screen; Escape is the browser's, leaving it.
  const count = view?.count ?? 0;
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey || !count) return;
      if ((e.key === " " || e.key === "Enter") && (e.target as Element | null)?.closest?.("button")) return;
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        fullScreen();
        return;
      }
      const k = presenterKey(e.key, e.shiftKey);
      if (!k || k === "end") return;
      e.preventDefault();
      moved(moveSlide(want, count, k));
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [count, fullScreen, moved, want]);

  /*
   * A press on the slide, which the window takes, not the deck's frame
   * (inert here): the left third back, the rest forward, as the deck's own
   * tap. A second press soon after is a double-click, for full screen, so a
   * single one waits that long before it moves.
   */
  const tapTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(tapTimer.current), []);
  const tap = (e: MouseEvent<HTMLDivElement>): void => {
    clearTimeout(tapTimer.current);
    if (e.detail >= 2) {
      fullScreen();
      return;
    }
    if (!count) return;
    const r = e.currentTarget.getBoundingClientRect();
    const back = e.clientX - r.left < r.width / 3;
    tapTimer.current = setTimeout(() => moved(moveSlide(want, count, back ? "prev" : "next")), DOUBLE_MS);
  };

  return (
    <div className={`audience${awake ? "" : " is-idle"}`} ref={box} onMouseMove={stir}>
      {!full && (
        <header className="audience-bar" aria-hidden={!awake}>
          <span className="audience-words">
            <span className="label">Audience</span>
            <span className="audience-title">{got ? got.record.title : "Opening the deck"}</span>
            <span className="audience-hint">Drag this window to the room's screen</span>
          </span>
          <button type="button" className="btn btn--sm" disabled={!got} title="Full screen (F, or double-click)" onClick={fullScreen}>
            <FullscreenIcon />
            Full screen
          </button>
        </header>
      )}
      {error && (
        <p className="ops-alert ops-alert--err audience-error" role="alert">
          {error}
        </p>
      )}
      {got && (
        <div className="audience-stage" onClick={tap}>
          <div className="audience-frame" inert>
            <ArtifactPage ref={frame} record={got.record} page={got.page} locked presenting onDeck={setView} />
          </div>
        </div>
      )}
    </div>
  );
}
