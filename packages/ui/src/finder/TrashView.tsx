import { useEffect, useState, type ReactElement } from "react";

import { SheetFoot } from "@kos/kit";
import { bytesWords } from "@kos/shared";

import { api, type TrashedFile } from "../api.js";
import { FileIcon } from "../FileIcon.js";
import { ConfirmButton } from "../kit.js";
import { Modal } from "../Modal.js";
import { TRASH_LAYOUT, useColumns } from "./columns.js";
import { dateWords, parentOf } from "./model.js";

/**
 * The trash: what was moved there, from where and when, each with Restore
 * and Delete forever, as every trash has them; Empty trash asks once, in a
 * dialog that says it cannot be undone. Nothing leaves the trash any other way.
 */
export function TrashView({ onChanged, onDone, onError, onCount, rootName }: { onChanged: () => void; onDone?: (text: string) => void; onError: (text: string) => void; onCount: (n: number) => void; rootName: string }): ReactElement {
  const [items, setItems] = useState<TrashedFile[] | null>(null);
  useEffect(() => onCount(items?.length ?? 0), [items, onCount]);
  const [asking, setAsking] = useState(false);
  const cols = useColumns(TRASH_LAYOUT);
  const showing = (key: string): boolean => cols.shown.includes(key);
  const read = (): void => {
    void api
      .fileTrash()
      .then((t) => setItems(t.items))
      .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)));
  };
  useEffect(read, []);
  const act = (work: Promise<unknown>, done?: string): void => {
    void work
      .then(() => {
        read();
        onChanged();
        if (done) onDone?.(done);
      })
      .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)));
  };

  return (
    <div className="finder-trash">
      <div className="finder-trash-bar">
        <span className="hint">{items === null ? "Reading…" : items.length === 0 ? "The trash is empty." : `${items.length} item${items.length === 1 ? "" : "s"}. Nothing here is deleted until you empty it.`}</span>
        <button type="button" className="btn btn--sm btn--danger" disabled={!items?.length} onClick={() => setAsking(true)}>
          Empty trash
        </button>
      </div>
      {items && items.length > 0 && (
        <div className="finder-list" role="grid" aria-label="Trash" style={cols.style}>
          <div className="finder-list-head finder-list-head--trash" role="row" ref={cols.headRef}>
            <div role="columnheader" className="finder-col finder-col--name" data-head="name">
              <span className="finder-col-label">Name</span>
            </div>
            {showing("trashed") && (
              <div role="columnheader" className="finder-col" data-head="trashed">
                {cols.divider("trashed")}
                <span className="finder-col-label" data-col="trashed">Date trashed</span>
              </div>
            )}
            {showing("size") && (
              <div role="columnheader" className="finder-col finder-col--size" data-head="size">
                {cols.divider("size")}
                <span className="finder-col-label" data-col="size">Size</span>
              </div>
            )}
            <div role="columnheader" className="finder-col" aria-label="Actions" />
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
              {showing("trashed") && (
                <span role="gridcell" className="finder-col finder-col--modified" data-col="trashed">
                  {dateWords(item.trashedAt)}
                </span>
              )}
              {showing("size") && (
                <span role="gridcell" className="finder-col finder-col--size" data-col="size">
                  {item.kind === "file" ? bytesWords(item.size) : "--"}
                </span>
              )}
              <span role="gridcell" className="finder-col finder-col--acts">
                <button type="button" className="btn btn--sm" onClick={() => act(api.restoreFile(item.id), `Restored ${item.name} to ${parentOf(item.path) === "." ? rootName : parentOf(item.path)}`)}>
                  Restore
                </button>
                <ConfirmButton label="Delete forever" text={`Delete ${item.name} for good? This cannot be undone.`} confirmLabel="Delete" onConfirm={() => act(api.emptyFileTrash([item.id]))} />
              </span>
            </div>
          ))}
        </div>
      )}
      <Modal
        open={asking}
        size="sm"
        title="Empty the trash?"
        onClose={() => setAsking(false)}
        footer={
          <SheetFoot
            onCancel={() => setAsking(false)}
            primary={
              <button
                type="button"
                className="btn btn--danger"
                onClick={() => {
                  setAsking(false);
                  act(api.emptyFileTrash());
                }}
              >
                Empty trash
              </button>
            }
          />
        }
      >
        <p className="file-dialog">
          {items?.length ?? 0} item{items?.length === 1 ? "" : "s"} will be deleted for good. This cannot be undone.
        </p>
      </Modal>
    </div>
  );
}
