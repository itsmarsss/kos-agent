import { useState, type ReactElement } from "react";

import { FilePreview, PreviewLinks, type LocalFile } from "./FilePreview.js";

/**
 * Attachments as a row of small squares, in the composer and in the message.
 *
 * A full-width image inside a bubble pushes the sentence it belongs to off the
 * screen, and a stack of them turns a short message into a scroll. Squares of
 * a fixed size read as "things attached to this", and the one that matters is
 * opened rather than always shown large: in the same window the Files page
 * opens a file in, so a kept file is itself (a PDF in the browser's viewer,
 * an Office file as its text) with Raw for the words KOS reads out of it.
 */

export interface StripItem {
  name: string;
  /** Ready-to-render source for an image, absent for anything else. */
  src?: string;
  /** Contents of a text file, so opening one shows the file. */
  text?: string;
  /** Where the file itself is kept in the workspace: opened as itself. */
  path?: string;
}

/** More than this in one message is a folder, not an attachment. */
export const MAX_ATTACHMENTS = 10;

/** The window's key for an item: its path when the file is kept, one of its own while it is only here. */
function keyOf(item: StripItem, i: number): string {
  return item.path ?? `attached:${i}:${item.name}`;
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

  const keys = items.map(keyOf);
  const locals: Record<string, LocalFile> = {};
  items.forEach((item, i) => {
    if (item.path) return;
    locals[keys[i]!] = { name: item.name, ...(item.text !== undefined ? { text: item.text } : {}), ...(item.src ? { src: item.src } : {}) };
  });
  const openKey = open === null ? null : (keys[open] ?? null);
  const kept = open === null ? undefined : items[open]?.path;

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
      <FilePreview
        path={openKey}
        siblings={keys}
        locals={locals}
        onStep={(key) => setOpen(keys.indexOf(key))}
        onClose={() => setOpen(null)}
        actions={kept ? <PreviewLinks path={kept} onOpenInFiles={() => setOpen(null)} /> : undefined}
      />
    </>
  );
}
