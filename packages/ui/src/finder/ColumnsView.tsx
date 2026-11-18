import { useEffect, useRef, type ReactElement } from "react";

import { ChevronRight } from "@kos/kit";

import type { DirEntry } from "../api.js";
import { FileIcon } from "../FileIcon.js";
import { FileFacts } from "./FileFacts.js";
import { EntryName, rowProps, type RowHandlers } from "./rows.js";

/**
 * Columns: the path as panes side by side, each folder's contents beside the
 * folder chosen in it, and the chosen file's picture and facts at the end.
 */

export interface Column {
  path: string;
  entries: DirEntry[] | undefined;
  error?: string;
  /** What is chosen in it: the next column's folder, or the file shown at the end. */
  chosen: string | null;
}

export function ColumnsView({ columns, preview, rootName, h, actions }: { columns: Column[]; preview: DirEntry | null; rootName: string; h: RowHandlers; actions?: ReactElement }): ReactElement {
  const strip = useRef<HTMLDivElement>(null);
  // A new column opening at the right is brought into view.
  useEffect(() => {
    const el = strip.current;
    el?.scrollTo?.({ left: el.scrollWidth, behavior: "smooth" });
  }, [columns.length, preview?.path]);
  return (
    <div className="finder-columns" ref={strip}>
      {columns.map((col) => (
        <div key={col.path} className={`finder-column${h.over === col.path ? " is-drop" : ""}`} role="listbox" aria-label={col.path === "." ? rootName : (col.path.split("/").pop() ?? col.path)} aria-multiselectable="true" {...h.drop(col.path)}>
          {col.error && <p className="finder-empty">{col.error}</p>}
          {col.entries?.length === 0 && <p className="finder-empty">Empty</p>}
          {col.entries?.map((entry) => (
            <div
              key={entry.path}
              role="option"
              className={`finder-crow${h.selected.has(entry.path) ? " is-selected" : ""}${col.chosen === entry.path ? " is-chosen" : ""}${h.lead === entry.path ? " is-lead" : ""}${h.over === entry.path ? " is-drop" : ""}`}
              {...rowProps(entry, h)}
              {...h.drag(entry)}
              {...(entry.kind === "dir" ? h.drop(entry.path) : {})}
            >
              <FileIcon name={entry.name} kind={entry.kind} size={16} />
              <EntryName entry={entry} h={h} />
              {entry.kind === "dir" && <ChevronRight size={11} title="" />}
            </div>
          ))}
        </div>
      ))}
      {preview && (
        <div className="finder-column finder-column--preview">
          <FileFacts path={preview.path} version={preview.modifiedAt} rootName={rootName} compact />
          {actions}
        </div>
      )}
    </div>
  );
}
