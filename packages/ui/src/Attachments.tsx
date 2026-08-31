import React, { useRef, useState, type ReactElement } from "react";

import type { Attachment } from "./api.js";

/**
 * Attaching files to a message: a button, a drop target, and a row of chips.
 *
 * Files are read here rather than uploaded, because the model needs the bytes
 * and the workspace is not reachable from a provider. An image shows its own
 * thumbnail so it is obvious which picture is about to be sent.
 */

export function readFile(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`could not read ${file.name}`));
    reader.onload = () => {
      const result = String(reader.result);
      // A data URI is "data:<type>;base64,<payload>"; only the payload travels.
      const comma = result.indexOf(",");
      resolve({
        name: file.name,
        mediaType: file.type,
        data: comma >= 0 ? result.slice(comma + 1) : result,
      });
    };
    reader.readAsDataURL(file);
  });
}

export function useAttachments(): {
  files: Attachment[];
  add: (list: FileList | null) => Promise<void>;
  remove: (index: number) => void;
  clear: () => void;
} {
  const [files, setFiles] = useState<Attachment[]>([]);
  return {
    files,
    add: async (list) => {
      if (!list?.length) return;
      const read = await Promise.all(Array.from(list).map(readFile));
      setFiles((f) => [...f, ...read]);
    },
    remove: (index) => setFiles((f) => f.filter((_, i) => i !== index)),
    clear: () => setFiles([]),
  };
}

export function AttachmentBar({
  files,
  onRemove,
}: {
  files: Attachment[];
  onRemove: (index: number) => void;
}): ReactElement | null {
  // Chips only, and only when there is something to show. The button lives in
  // the composer row: a permanent "or drop files here" strip above every
  // message box is a file uploader wearing a chat's clothes.
  if (files.length === 0) return null;
  return (
    <div className="attach-chips">
      {files.map((f, i) => (
        <span className="attach-chip" key={`${f.name}-${i}`}>
          {f.mediaType.startsWith("image/") && (
            <img
              className="attach-thumb"
              alt=""
              src={`data:${f.mediaType};base64,${f.data}`}
            />
          )}
          <span className="attach-name">{f.name}</span>
          <button
            type="button"
            className="attach-x"
            aria-label={`Remove ${f.name}`}
            onClick={() => onRemove(i)}
          >
            ✕
          </button>
        </span>
      ))}
    </div>
  );
}

/** The paperclip that sits inside the composer, beside the send button. */
export function AttachButton({
  onAdd,
}: {
  onAdd: (list: FileList | null) => void;
}): ReactElement {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className="composer-icon"
        title="Attach files"
        aria-label="Attach files"
        onClick={() => input.current?.click()}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.2-9.19a4 4 0 0 1 5.65 5.66l-9.2 9.19a2 2 0 0 1-2.82-2.83l8.49-8.48"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          onAdd(e.target.files);
          // Cleared so picking the same file twice still fires a change.
          e.target.value = "";
        }}
      />
    </>
  );
}

/** Drop anywhere on the composer, which is where a file is aimed. */
export function useDropZone(onAdd: (list: FileList | null) => void): {
  over: boolean;
  handlers: {
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: () => void;
    onDrop: (e: React.DragEvent) => void;
  };
} {
  const [over, setOver] = useState(false);
  return {
    over,
    handlers: {
      onDragOver: (e) => {
        e.preventDefault();
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (e) => {
        e.preventDefault();
        setOver(false);
        onAdd(e.dataTransfer.files);
      },
    },
  };
}
