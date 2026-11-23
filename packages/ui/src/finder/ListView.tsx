import type { ReactElement, ReactNode } from "react";

import { ChevronRight, Skeleton } from "@kos/kit";
import { bytesWords } from "@kos/shared";

import type { DirEntry } from "../api.js";
import { FileIcon } from "../FileIcon.js";
import { FILES_LAYOUT, useColumns, type ColumnLayout } from "./columns.js";
import { levelStyle, treeStyle } from "./indent.js";
import { dateWords, kindOf, parentOf, sortBy, type Sort, type SortKey } from "./model.js";
import { EntryName, rowId, rowProps, stateClass, type RowHandlers } from "./rows.js";

/**
 * The list: a row per thing, sortable by any column, a folder opening in
 * place under its triangle, stepped in as indent.ts says. Rows are one
 * height whatever they hold. The columns after Name are resized by the
 * dividers in the head (columns.tsx).
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

const LABELS: Record<SortKey, string> = { name: "Name", modified: "Date modified", size: "Size", kind: "Kind" };

/** The rows drawn while a folder is read: a few names of a few lengths, as a folder has. */
const READING_WIDTHS = ["42%", "30%", "55%", "36%", "48%", "26%"];

export function ListView({ rows, sort, onSort, onToggle, h, empty, reading = false, layout = FILES_LAYOUT }: { rows: ListRow[]; sort: Sort; onSort: (sort: Sort) => void; onToggle?: (entry: DirEntry) => void; h: RowHandlers; empty: ReactNode; /** The folder is still being read: rows in its shape, not words. */ reading?: boolean; /** Its columns and where their widths are kept: one place a Finder is drawn's apart from another's. */ layout?: ColumnLayout }): ReactElement {
  const cols = useColumns(layout);
  const keys: SortKey[] = ["name", ...(cols.shown as SortKey[])];
  const cell = (key: SortKey, entry: DirEntry): ReactNode =>
    key === "modified" ? dateWords(entry.modifiedAt) : key === "size" ? (entry.kind === "file" ? bytesWords(entry.size) : "--") : kindOf(entry);
  return (
    <div className="finder-list" role="grid" aria-multiselectable="true" aria-label="Files" aria-rowcount={rows.length} style={{ ...cols.style, ...treeStyle(rows) }}>
      <div className="finder-list-head" role="row" ref={cols.headRef}>
        {keys.map((key) => (
          <div key={key} role="columnheader" aria-label={LABELS[key]} data-head={key} className={`finder-col finder-col--${key}`} aria-sort={sort.key === key ? (sort.desc ? "descending" : "ascending") : "none"}>
            {cols.divider(key)}
            <button type="button" className="finder-col-label" data-col={key} onClick={() => onSort(sortBy(sort, key))}>
              {LABELS[key]}
              {sort.key === key && <span className={`finder-sort${sort.desc ? " is-desc" : ""}`} aria-hidden="true" />}
            </button>
          </div>
        ))}
      </div>
      {rows.length === 0 &&
        (reading ? (
          <div className="finder-reading" aria-busy="true" aria-label="Reading the folder">
            {READING_WIDTHS.map((w, i) => (
              <Skeleton key={i} width={w} height={12} />
            ))}
          </div>
        ) : (
          <div className="finder-empty">{empty}</div>
        ))}
      {rows.map(({ entry, depth, open, where, match }) => (
        <div
          key={entry.path}
          role="row"
          id={rowId(entry.path)}
          // Its name first, then its facts: read from its cells, the folder's disclosure led ("Open artifacts here artifacts").
          aria-label={[entry.name, ...keys.slice(1).map((key) => cell(key, entry))].filter((w) => typeof w === "string" && w !== "--").join(", ")}
          className={`finder-row${stateClass(entry, h)}`}
          {...rowProps(entry, h)}
          {...h.drag(entry)}
          {...(entry.kind === "dir" ? h.drop(entry.path) : {})}
        >
          <span role="gridcell" className="finder-col finder-col--name" style={levelStyle(depth)}>
            {depth > 0 && <span className="finder-guide" style={levelStyle(depth - 1)} aria-hidden="true" />}
            {entry.kind === "dir" && onToggle && where === undefined ? (
              <button
                type="button"
                className={`finder-disclose${open ? " is-open" : ""}`}
                aria-label={open ? `Close ${entry.name}` : `Open ${entry.name} here`}
                aria-expanded={open}
                tabIndex={-1}
                onMouseDown={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onClick={(e) => {
                  // Its own: on a phone a tap on the row opens it, and the chevron only unfolds it.
                  e.stopPropagation();
                  onToggle(entry);
                }}
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
          {keys.slice(1).map((key) => (
            <span key={key} role="gridcell" className={`finder-col finder-col--${key}`} data-col={key}>
              {cell(key, entry)}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
