import { useEffect, useRef, type DragEvent, type MouseEvent, type ReactElement } from "react";

import { Tooltip } from "@kos/kit";

import type { DirEntry } from "../api.js";
import { FitName } from "./names.js";

/** What a row of KOS's own (kos.sqlite, profile.json) says when pointed at. */
export const RESERVED_TIP = "KOS keeps its own records here, so it can't be renamed, moved or trashed.";

/**
 * What every view of a folder shares: how a row answers the pointer, how
 * it is dragged and dropped on, and the name that turns into a field to
 * rename in place.
 */

export interface RowHandlers {
  selected: ReadonlySet<string>;
  lead: string | null;
  /** The row being renamed in place. */
  editing: string | null;
  /** The folder something is being dragged over. */
  over: string | null;
  /** What this page is dragging, drawn faded where it was. */
  dragged?: ReadonlySet<string>;
  press: (e: MouseEvent, entry: DirEntry) => void;
  open: (entry: DirEntry) => void;
  menu: (e: MouseEvent, entry: DirEntry) => void;
  /** The new name, or null to leave it as it was. */
  renamed: (entry: DirEntry, name: string | null) => void;
  drag: (entry: DirEntry) => { draggable: boolean; onDragStart: (e: DragEvent) => void; onDragEnd: () => void };
  /** A folder that takes a drop: a row dragged from here, or files from the desktop. */
  drop: (dir: string) => { onDragOver: (e: DragEvent) => void; onDragLeave: (e: DragEvent) => void; onDrop: (e: DragEvent) => void };
}

/** A row's or tile's state as classes: chosen, the lead, a drop's target, being dragged. */
export const stateClass = (entry: DirEntry, h: RowHandlers): string =>
  `${h.selected.has(entry.path) ? " is-selected" : ""}${h.lead === entry.path ? " is-lead" : ""}${h.over === entry.path ? " is-drop" : ""}${h.dragged?.has(entry.path) ? " is-dragged" : ""}`;

/** The pointer on a row: press selects, a second press opens, the other button asks for the menu. */
export function rowProps(entry: DirEntry, h: RowHandlers): {
  "aria-selected": boolean;
  "data-path": string;
  "data-reserved"?: true;
  onMouseDown: (e: MouseEvent) => void;
  onDoubleClick: () => void;
  onContextMenu: (e: MouseEvent) => void;
} {
  return {
    "aria-selected": h.selected.has(entry.path),
    "data-path": entry.path,
    ...(entry.reserved ? { "data-reserved": true as const } : {}),
    onMouseDown: (e) => {
      if (e.button === 0) h.press(e, entry);
    },
    onDoubleClick: () => h.open(entry),
    onContextMenu: (e) => h.menu(e, entry),
  };
}

/** A name, or the field it becomes while it is renamed: Return keeps it, Escape leaves it, the name chosen without its extension. */
export function EntryName({ entry, h, className = "finder-name" }: { entry: DirEntry; h: RowHandlers; className?: string }): ReactElement {
  const field = useRef<HTMLInputElement>(null);
  const editing = h.editing === entry.path;
  useEffect(() => {
    const el = field.current;
    if (!editing || !el) return;
    el.focus();
    const dot = entry.kind === "file" ? el.value.lastIndexOf(".") : -1;
    el.setSelectionRange(0, dot > 0 ? dot : el.value.length);
  }, [editing, entry.kind]);
  if (!editing) {
    if (entry.reserved) {
      return (
        <Tooltip tip={RESERVED_TIP}>
          <span className={className}>{entry.name}</span>
        </Tooltip>
      );
    }
    // A tile's name wraps to two lines; a row's is one line, cut in the middle.
    if (className === "finder-tile-name") {
      return (
        <span className={className} title={entry.name}>
          {entry.name}
        </span>
      );
    }
    return <FitName name={entry.name} isFile={entry.kind === "file"} className={className} />;
  }
  let settled = false;
  const settle = (name: string | null): void => {
    if (settled) return;
    settled = true;
    h.renamed(entry, name);
  };
  return (
    <input
      ref={field}
      className="finder-rename"
      defaultValue={entry.name}
      aria-label={`Rename ${entry.name}`}
      spellCheck={false}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") settle(e.currentTarget.value);
        else if (e.key === "Escape") settle(null);
      }}
      onBlur={(e) => settle(e.currentTarget.value)}
    />
  );
}
