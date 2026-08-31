import { useEffect, useState, type ReactElement } from "react";

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
        {item.src ? (
          <img className="viewer-image" src={item.src} alt={item.name} />
        ) : (
          <div className="viewer-file">{item.name}</div>
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
