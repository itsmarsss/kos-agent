import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from "react";

import { api, type PageSummary } from "../api.js";

/** How many artifacts the picker lists at once; typing narrows them. */
const SHOWN = 8;

const KIND: Record<string, string> = { page: "Page", doc: "Doc", deck: "Deck", sheet: "Sheet" };

export interface MentionPickerProps {
  /** Where it opens, in the dashboard's view: under the doc's caret. */
  at: { x: number; y: number };
  /** The doc it is for, which it does not offer. */
  exclude: string;
  onPick: (artifact: PageSummary) => void;
  /** Closed without a pick; `refocus` false when the owner already went elsewhere (back into the doc, another window). */
  onClose: (refocus: boolean) => void;
}

/**
 * The artifact picker behind a doc's @ mention, drawn by the dashboard
 * rather than the doc's frame: the frame never sees the list of artifacts,
 * only the one the owner picks (its id and title), so a page cannot read
 * what else the workspace holds through it.
 */
export function MentionPicker({ at, exclude, onPick, onClose }: MentionPickerProps): ReactElement {
  const [all, setAll] = useState<PageSummary[]>();
  const [query, setQuery] = useState("");
  const [pick, setPick] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    api.pages().then(
      (pages) => live && setAll(pages.filter((p) => p.kind === "html" && p.id !== exclude && !p.blobRemoved).sort((a, b) => b.updatedAt - a.updatedAt)),
      () => live && setAll([]),
    );
    return () => {
      live = false;
    };
  }, [exclude]);

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (all ?? []).filter((p) => words.every((w) => p.title.toLowerCase().includes(w))).slice(0, SHOWN);
  }, [all, query]);

  // Closed when the owner goes elsewhere: a press outside it, focus leaving it, or the window losing focus (a press back in the doc's frame does that).
  useEffect(() => {
    const away = (e: PointerEvent): void => {
      if (!box.current?.contains(e.target as Node)) onClose(false);
    };
    const left = (): void => onClose(false);
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("blur", left);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("blur", left);
    };
  }, [onClose]);

  /** Tab cycles within the picker while it is open: its field, then its rows. */
  const trap = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== "Tab" || !box.current) return;
    const stops = [...box.current.querySelectorAll<HTMLElement>("input, button")];
    if (!stops.length) return;
    const at = stops.indexOf(document.activeElement as HTMLElement);
    e.preventDefault();
    stops[(at + (e.shiftKey ? stops.length - 1 : 1) + stops.length) % stops.length]!.focus();
  };

  const left = Math.max(8, Math.min(at.x, window.innerWidth - 328));
  const top = at.y + 300 > window.innerHeight ? Math.max(8, at.y - 330) : at.y + 6;

  return (
    <div
      className="mention-picker"
      ref={box}
      style={{ left, top }}
      role="dialog"
      aria-label="Mention an artifact"
      onKeyDown={trap}
      onBlur={(e) => {
        if (!box.current?.contains(e.relatedTarget as Node | null) && e.relatedTarget !== null) onClose(false);
      }}
    >
      <input
        autoFocus
        className="mention-picker-search"
        placeholder="Mention an artifact…"
        value={query}
        role="combobox"
        aria-expanded="true"
        aria-controls="mention-picker-list"
        aria-activedescendant={shown[pick] ? `mention-${shown[pick].id}` : undefined}
        onChange={(e) => {
          setQuery(e.target.value);
          setPick(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (shown.length) setPick((pick + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length);
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (shown[pick]) onPick(shown[pick]);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose(true);
          }
        }}
      />
      <div id="mention-picker-list" role="listbox" aria-label="Artifacts">
        {all === undefined && <p className="mention-picker-none">Loading…</p>}
        {all !== undefined && !shown.length && <p className="mention-picker-none">No artifact by that name</p>}
        {shown.map((p, i) => (
          <button
            key={p.id}
            id={`mention-${p.id}`}
            type="button"
            role="option"
            aria-selected={i === pick}
            className={i === pick ? "on" : undefined}
            onMouseMove={() => setPick(i)}
            onClick={() => onPick(p)}
          >
            <span>{p.title}</span>
            <small>{KIND[p.artifactKind] ?? "Page"}</small>
          </button>
        ))}
      </div>
    </div>
  );
}
