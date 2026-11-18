import { useEffect, useState, type ReactElement } from "react";

import { api, type TrashedFile } from "../api.js";
import { FileIcon } from "../FileIcon.js";
import { ConfirmButton } from "../kit.js";
import { Modal } from "../Modal.js";
import { TRASH_COLUMNS, TRASH_WIDTHS_KEY, useColumns } from "./columns.js";
import { dateWords, parentOf, sizeWords } from "./model.js";

/**
 * The trash: what was moved there, from where and when, each with Put Back
 * and Delete Immediately; Empty Trash asks once, in a dialog that says it
 * cannot be undone. Nothing leaves the trash any other way.
 */
export function TrashView({ onChanged, onError, onCount, rootName }: { onChanged: () => void; onError: (text: string) => void; onCount: (n: number) => void; rootName: string }): ReactElement {
  const [items, setItems] = useState<TrashedFile[] | null>(null);
  useEffect(() => onCount(items?.length ?? 0), [items, onCount]);
  const [asking, setAsking] = useState(false);
  const cols = useColumns(TRASH_WIDTHS_KEY, TRASH_COLUMNS, "15rem");
  const read = (): void => {
    void api
      .fileTrash()
      .then((t) => setItems(t.items))
      .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)));
  };
  useEffect(read, []);
  const act = (work: Promise<unknown>): void => {
    void work
      .then(() => {
        read();
        onChanged();
      })
      .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)));
  };

  return (
    <div className="finder-trash">
      <div className="finder-trash-bar">
        <span className="hint">{items === null ? "Reading…" : items.length === 0 ? "The Trash is empty." : `${items.length} item${items.length === 1 ? "" : "s"}. Nothing here is deleted until you empty it.`}</span>
        <button type="button" className="btn btn--sm btn--danger" disabled={!items?.length} onClick={() => setAsking(true)}>
          Empty Trash
        </button>
      </div>
      {items && items.length > 0 && (
        <div className="finder-list" role="grid" aria-label="Trash" style={cols.style}>
          <div className="finder-list-head finder-list-head--trash" role="row" ref={cols.headRef}>
            <span role="columnheader" className="finder-col finder-col--name" data-col="name" style={{ gridColumn: 1 }}>Name</span>
            <span role="columnheader" className="finder-col" data-col="trashed" style={{ gridColumn: 2 }}>Date Trashed</span>
            <span role="columnheader" className="finder-col finder-col--size" data-col="size" style={{ gridColumn: 3 }}>Size</span>
            <span role="columnheader" className="finder-col" aria-label="Actions" style={{ gridColumn: 4 }} />
            {cols.dividers}
          </div>
          {items.map((item) => (
            <div key={item.id} role="row" className="finder-row finder-row--trash">
              <span role="gridcell" className="finder-col finder-col--name">
                <FileIcon name={item.name} kind={item.kind} size={16} />
                <span className="finder-name-wrap">
                  <span className="finder-name">{item.name}</span>
                  <span className="finder-where">From {parentOf(item.path) === "." ? rootName : parentOf(item.path)}</span>
                </span>
              </span>
              <span role="gridcell" className="finder-col finder-col--modified" data-col="trashed">
                {dateWords(item.trashedAt)}
              </span>
              <span role="gridcell" className="finder-col finder-col--size" data-col="size">
                {item.kind === "file" ? sizeWords(item.size) : "--"}
              </span>
              <span role="gridcell" className="finder-col finder-col--acts">
                <button type="button" className="btn btn--sm" onClick={() => act(api.restoreFile(item.id))}>
                  Put Back
                </button>
                <ConfirmButton label="Delete Immediately" text={`Delete ${item.name} for good? This cannot be undone.`} confirmLabel="Delete" onConfirm={() => act(api.emptyFileTrash([item.id]))} />
              </span>
            </div>
          ))}
        </div>
      )}
      <Modal open={asking} size="sm" title="Empty the Trash?" onClose={() => setAsking(false)}>
        <div className="file-dialog">
          <p>
            {items?.length ?? 0} item{items?.length === 1 ? "" : "s"} will be deleted for good. This cannot be undone.
          </p>
          <div className="file-dialog-actions">
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => {
                setAsking(false);
                act(api.emptyFileTrash());
              }}
            >
              Empty Trash
            </button>
            <button type="button" className="btn" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
