import type { ReactElement, ReactNode } from "react";

import { Skeleton } from "@kos/kit";
import { bytesWords } from "@kos/shared";

import type { DirEntry } from "../api.js";
import { FileIcon } from "../FileIcon.js";
import { Thumb } from "../FileThumb.js";
import { kindOf } from "./model.js";
import { EntryName, rowProps, stateClass, type RowHandlers } from "./rows.js";

/**
 * Icons: each thing as its picture where it has one (a photo, a PDF's first
 * page, a deck's first slide), else its kind's mark, its name under it.
 */
export function GalleryView({ entries, h, empty, reading = false }: { entries: DirEntry[]; h: RowHandlers; empty: ReactNode; /** Still being read: tiles in its shape. */ reading?: boolean }): ReactElement {
  if (entries.length === 0 && reading) {
    return (
      <div className="finder-gallery" aria-busy="true" aria-label="Reading the folder">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="finder-tile-skeleton" radius="var(--r-md)" />
        ))}
      </div>
    );
  }
  if (entries.length === 0) return <div className="finder-empty">{empty}</div>;
  return (
    <div className="finder-gallery" role="grid" aria-multiselectable="true" aria-label="Files">
      {entries.map((entry) => (
        <div
          key={entry.path}
          role="gridcell"
          className={`finder-tile${stateClass(entry, h)}`}
          title={`${entry.name}\n${kindOf(entry)}${entry.kind === "file" ? `, ${bytesWords(entry.size)}` : ""}`}
          {...rowProps(entry, h)}
          {...h.drag(entry)}
          {...(entry.kind === "dir" ? h.drop(entry.path) : {})}
        >
          <span className="finder-tile-art">
            {entry.kind === "dir" ? (
              <span className="files-thumb">
                <FileIcon name={entry.name} kind="dir" size={44} />
              </span>
            ) : (
              <Thumb path={entry.path} name={entry.name} edge={256} iconSize={40} version={entry.modifiedAt} />
            )}
          </span>
          <EntryName entry={entry} h={h} className="finder-tile-name" />
        </div>
      ))}
    </div>
  );
}
