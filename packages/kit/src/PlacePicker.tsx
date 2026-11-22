import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from "react";

import { CheckIcon } from "./icons.js";
import { SearchField } from "./PageParts.js";

/** One place something can live: the workspace, a folder, a project, a blob. */
export interface Place {
  id: string;
  /** The name the owner knows it by: "Reading log", "Plant watcher"; never its slug. */
  name: string;
  group: "workspace" | "folder" | "project" | "blob";
  /** Its mark: a project's tile, a blob's face, a folder's icon. */
  mark?: ReactNode;
  /** A line under the name: a folder's path inside its place. */
  detail?: string;
}

/** The groups in their order, each under its name; the workspace is one place, not a group. */
const GROUPS: readonly [Place["group"], string | null][] = [
  ["workspace", null],
  ["folder", "Folders"],
  ["project", "Projects"],
  ["blob", "Blobs"],
];

/** How many places are listed before a search over them is offered. */
export const FIND_FROM = 8;

/**
 * Where to move something: one radio group of places under each group's
 * name (the workspace, folders, projects, blobs), each by its name and mark,
 * the one it is in now marked "Here now" and not offered. One stop on the
 * tab key (the place chosen, else the first that can be); the arrows walk
 * the places and choose as they go, Home and End go to the ends; a long list
 * gets a search. A file's Move and an artifact's are this one picker.
 */
export function PlacePicker({ places, current, value, onChoose, label = "Move to" }: { places: readonly Place[]; current?: string; value: string | null; onChoose: (id: string | null) => void; label?: string }): ReactElement {
  const list = useRef<HTMLDivElement>(null);
  const ids = useId();
  const [find, setFind] = useState("");
  const q = find.trim().toLowerCase();
  const shown = q ? places.filter((p) => `${p.name} ${p.detail ?? ""}`.toLowerCase().includes(q)) : places;
  // A place the search hides is not where Move goes: the choice is let go, and Move waits for another.
  const hidden = value !== null && !shown.some((p) => p.id === value);
  useEffect(() => {
    if (hidden) onChoose(null);
  }, [hidden]);
  const open = shown.filter((p) => p.id !== current);
  const stop = open.some((p) => p.id === value) ? value : open[0]?.id;
  const keys = (e: KeyboardEvent<HTMLDivElement>): void => {
    const at = open.findIndex((p) => p.id === stop);
    const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    const to = e.key === "Home" ? 0 : e.key === "End" ? open.length - 1 : step ? (at + step + open.length) % open.length : -1;
    const next = open[to];
    if (!next) return;
    e.preventDefault();
    onChoose(next.id);
    [...(list.current?.querySelectorAll<HTMLElement>("[data-place]") ?? [])].find((el) => el.dataset.place === next.id)?.focus();
  };
  const row = (p: Place): ReactElement => {
    const here = p.id === current;
    const chosen = p.id === value;
    return (
      <button
        key={p.id}
        type="button"
        role="radio"
        data-place={p.id}
        aria-checked={chosen}
        disabled={here}
        tabIndex={p.id === stop ? 0 : -1}
        className="place-row"
        title={p.detail ? `${p.name}, ${p.detail}` : p.name}
        onClick={() => onChoose(p.id)}
      >
        {p.mark && <span className="place-mark">{p.mark}</span>}
        <span className="place-words">
          <span className="place-name">{p.name}</span>
          {p.detail && <span className="place-detail">{p.detail}</span>}
        </span>
        {here && <span className="place-here">Here now</span>}
        {chosen && <CheckIcon size={14} title="" />}
      </button>
    );
  };
  return (
    <div className="place-pick">
      {places.length > FIND_FROM && <SearchField value={find} onChange={setFind} noun="places" />}
      <div className="place-picker" role="radiogroup" aria-label={label} ref={list} onKeyDown={keys}>
        {shown.length === 0 && <p className="empty-line">Nowhere by that name.</p>}
        {GROUPS.map(([group, head]) => {
          const rows = shown.filter((p) => p.group === group);
          if (rows.length === 0) return null;
          if (!head) return rows.map(row);
          return (
            <div key={group} role="group" aria-labelledby={`${ids}-${group}`} className="place-group">
              <p className="place-group-head" id={`${ids}-${group}`}>
                {head}
              </p>
              {rows.map(row)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
