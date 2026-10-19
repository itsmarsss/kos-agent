import { useEffect, useState, type ReactElement } from "react";

import { api, type FileContent } from "./api.js";
import { FileBody } from "./FilePreview.js";
import { hrefFor } from "./routes.js";

/**
 * Attachments as a row of small squares, in the composer and in the message.
 *
 * A full-width image inside a bubble pushes the sentence it belongs to off the
 * screen, and a stack of them turns a short message into a scroll. Squares of
 * a fixed size read as "things attached to this", and the one that matters is
 * opened rather than always shown large.
 */

export interface StripItem {
  name: string;
  /** Ready-to-render source for an image, absent for anything else. */
  src?: string;
  /** Contents of a text file, so opening one shows the file. */
  text?: string;
  /** Where the file itself is kept in the workspace: opened as itself, with the text as the other view. */
  path?: string;
}

/**
 * A kept file, as the Files page shows it: a PDF in the browser's viewer,
 * a Word or Excel file as its text, an image as itself. The words the
 * model was given (a PDF read as text) are the other view, since what was
 * attached and what was read are not the same thing.
 */
function KeptFile({ item }: { item: StripItem }): ReactElement {
  const [file, setFile] = useState<FileContent | null>(null);
  const [raw, setRaw] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setFile(null);
    setError(null);
    setRaw(false);
    if (!item.path) return undefined;
    void api
      .file(item.path)
      .then((f) => {
        if (!cancelled) setFile(f);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [item.path]);
  return (
    <div className="viewer-kept">
      <div className="viewer-modes">
        <button type="button" className={`btn btn--sm ${raw ? "btn--ghost" : ""}`} onClick={() => setRaw(false)}>
          File
        </button>
        {item.text !== undefined && (
          <button type="button" className={`btn btn--sm ${raw ? "" : "btn--ghost"}`} onClick={() => setRaw(true)} title="The words the model was given">
            Raw text
          </button>
        )}
        {item.path && (
          <a className="btn btn--sm btn--ghost" href={hrefFor({ name: "files", path: item.path })}>
            Open in Files
          </a>
        )}
      </div>
      {raw ? (
        <pre className="viewer-text">{item.text}</pre>
      ) : error ? (
        <p className="hint preview-hint">The file is no longer there: {error}</p>
      ) : file ? (
        <FileBody file={file} />
      ) : (
        <p className="hint preview-hint">Opening…</p>
      )}
    </div>
  );
}

/** More than this in one message is a folder, not an attachment. */
export const MAX_ATTACHMENTS = 10;

function Viewer({
  items,
  index,
  onClose,
  onMove,
}: {
  items: StripItem[];
  index: number;
  onClose: () => void;
  onMove: (next: number) => void;
}): ReactElement {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") onMove((index + 1) % items.length);
      if (e.key === "ArrowLeft") onMove((index - 1 + items.length) % items.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, items.length, onClose, onMove]);

  const item = items[index];
  if (!item) return <></>;

  return (
    <div className="viewer" role="dialog" aria-label={item.name} onClick={onClose}>
      <div className="viewer-inner" onClick={(e) => e.stopPropagation()}>
        {item.path && !item.src ? (
          <KeptFile item={item} />
        ) : item.src ? (
          <img className="viewer-image" src={item.src} alt={item.name} />
        ) : (
          // The point of opening a text file is reading it, not being told
          // its extension again.
          <pre className="viewer-text">{item.text ?? "(no preview)"}</pre>
        )}
        <div className="viewer-bar">
          {items.length > 1 && (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => onMove((index - 1 + items.length) % items.length)}
            >
              ‹
            </button>
          )}
          <span className="viewer-name">{item.name}</span>
          {items.length > 1 && (
            <span className="viewer-count">
              {index + 1} of {items.length}
            </span>
          )}
          {items.length > 1 && (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => onMove((index + 1) % items.length)}
            >
              ›
            </button>
          )}
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}

export function AttachmentStrip({
  items,
  onRemove,
}: {
  items: StripItem[];
  /** Present in a composer, absent in a sent message. */
  onRemove?: (index: number) => void;
}): ReactElement | null {
  const [open, setOpen] = useState<number | null>(null);
  if (items.length === 0) return null;

  return (
    <>
      <div className="strip">
        {items.map((item, i) => (
          <div className="strip-item" key={`${item.name}-${i}`}>
            <button
              type="button"
              className="strip-tile"
              title={item.name}
              onClick={() => setOpen(i)}
            >
              {item.src ? (
                <img src={item.src} alt="" />
              ) : (
                <span className="strip-ext">
                  {item.name.split(".").pop()?.slice(0, 4) ?? "file"}
                </span>
              )}
            </button>
            {onRemove && (
              <button
                type="button"
                className="strip-x"
                aria-label={`Remove ${item.name}`}
                onClick={() => onRemove(i)}
              >
                ✕
              </button>
            )}
            <span className="strip-name">{item.name}</span>
          </div>
        ))}
      </div>
      {open !== null && (
        <Viewer
          items={items}
          index={open}
          onClose={() => setOpen(null)}
          onMove={setOpen}
        />
      )}
    </>
  );
}
