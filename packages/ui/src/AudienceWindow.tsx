import { FullscreenIcon } from "@kos/kit";
import type { HtmlPage } from "@kos/shared";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

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

  // The presenter's keys work here too, for an owner whose hand is on this window; Escape is the browser's, leaving full screen.
  const count = view?.count ?? 0;
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey || !count) return;
      if ((e.key === " " || e.key === "Enter") && (e.target as Element | null)?.closest?.("button")) return;
      const k = presenterKey(e.key, e.shiftKey);
      if (!k || k === "end") return;
      e.preventDefault();
      moved(moveSlide(want, count, k));
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [count, moved, want]);

  useEffect(() => {
    const changed = (): void => setFull(document.fullscreenElement === box.current);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  const fullScreen = (): void => void box.current?.requestFullscreen?.().catch(() => undefined);

  return (
    <div className="audience" ref={box}>
      {!full && (
        <header className="audience-bar">
          <span className="audience-words">
            <span className="label">Audience</span>
            <span>{got ? `${got.record.title}: drag this window to the screen the room sees, then` : "Opening the deck"}</span>
          </span>
          <button type="button" className="btn btn--sm" disabled={!got} onClick={fullScreen}>
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
        <div className="audience-stage">
          <ArtifactPage ref={frame} record={got.record} page={got.page} locked presenting onDeck={setView} />
        </div>
      )}
    </div>
  );
}
