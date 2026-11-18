import type { ReactElement } from "react";

import { ChevronRight } from "@kos/kit";

import type { DirEntry } from "../api.js";
import { FileIcon } from "../FileIcon.js";
import { LIST_COLUMNS, LIST_WIDTHS_KEY, useColumns } from "./columns.js";
import { dateWords, kindOf, parentOf, sizeWords, type Sort, type SortKey } from "./model.js";
import { EntryName, rowProps, type RowHandlers } from "./rows.js";

/**
 * The list: a row per thing, sortable by any column, a folder opening in
 * place under its triangle. Rows are one height whatever they hold. The
 * columns after Name are resized by the dividers in the head (columns.tsx).
 */

export interface ListRow {
  entry: DirEntry;
  depth: number;
  /** A folder's state under its triangle; undefined for a file. */
  open?: boolean;
  /** A search's or Recents' row: the folder it is in, in place of the triangle. */
  where?: string;
  /** A contents search's line that matched. */
  match?: string;
}

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "modified", label: "Date Modified" },
  { key: "size", label: "Size" },
  { key: "kind", label: "Kind" },
];

export function ListView({ rows, sort, onSort, onToggle, h, empty, widthsKey = LIST_WIDTHS_KEY }: { rows: ListRow[]; sort: Sort; onSort: (sort: Sort) => void; onToggle?: (entry: DirEntry) => void; h: RowHandlers; empty: string; /** Where the columns' widths are kept: one place a Finder is drawn's apart from another's. */ widthsKey?: string }): ReactElement {
  const cols = useColumns(widthsKey, LIST_COLUMNS);
  return (
    <div className="finder-list" role="grid" aria-multiselectable="true" aria-label="Files" aria-rowcount={rows.length} style={cols.style}>
      <div className="finder-list-head" role="row" ref={cols.headRef}>
        {COLUMNS.map((c) => (
          <div key={c.key} role="columnheader" data-head={c.key} className={`finder-col finder-col--${c.key}`} aria-sort={sort.key === c.key ? (sort.desc ? "descending" : "ascending") : "none"}>
            {cols.divider(c.key)}
            <button type="button" className="finder-col-label" data-col={c.key} onClick={() => onSort({ key: c.key, desc: sort.key === c.key ? !sort.desc : c.key === "modified" || c.key === "size" })}>
              {c.label}
              {sort.key === c.key && <span className={`finder-sort${sort.desc ? " is-desc" : ""}`} aria-hidden="true" />}
            </button>
          </div>
        ))}
      </div>
      {rows.length === 0 && <p className="finder-empty">{empty}</p>}
      {rows.map(({ entry, depth, open, where, match }) => (
        <div
          key={entry.path}
          role="row"
          className={`finder-row${h.selected.has(entry.path) ? " is-selected" : ""}${h.lead === entry.path ? " is-lead" : ""}${h.over === entry.path ? " is-drop" : ""}`}
          {...rowProps(entry, h)}
          {...h.drag(entry)}
          {...(entry.kind === "dir" ? h.drop(entry.path) : {})}
        >
          <span role="gridcell" className="finder-col finder-col--name" style={{ paddingLeft: `calc(${depth} * 1.15rem + 0.35rem)` }}>
            {entry.kind === "dir" && onToggle && where === undefined ? (
              <button
                type="button"
                className={`finder-disclose${open ? " is-open" : ""}`}
                aria-label={open ? `Close ${entry.name}` : `Open ${entry.name} here`}
                aria-expanded={open}
                tabIndex={-1}
                onMouseDown={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onClick={() => onToggle(entry)}
              >
                <ChevronRight size={11} title="" />
              </button>
            ) : (
              <span className="finder-disclose" aria-hidden="true" />
            )}
            <FileIcon name={entry.name} kind={entry.kind} size={16} />
            <span className="finder-name-wrap">
              <EntryName entry={entry} h={h} />
              {(where !== undefined || match) && <span className="finder-where">{match ?? (where === "." ? "Workspace" : where ?? parentOf(entry.path))}</span>}
            </span>
          </span>
          <span role="gridcell" className="finder-col finder-col--modified" data-col="modified">
            {dateWords(entry.modifiedAt)}
          </span>
          <span role="gridcell" className="finder-col finder-col--size" data-col="size">
            {entry.kind === "file" ? sizeWords(entry.size) : "--"}
          </span>
          <span role="gridcell" className="finder-col finder-col--kind" data-col="kind">
            {kindOf(entry)}
          </span>
        </div>
      ))}
    </div>
  );
}
