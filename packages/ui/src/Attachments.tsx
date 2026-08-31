import { useRef, useState, type ReactElement } from "react";

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
  onAdd,
  onRemove,
}: {
  files: Attachment[];
  onAdd: (list: FileList | null) => void;
  onRemove: (index: number) => void;
}): ReactElement {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  return (
    <div
      className={`attach ${over ? "is-over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onAdd(e.dataTransfer.files);
      }}
    >
      <button
        type="button"
        className="btn btn--ghost attach-add"
        onClick={() => input.current?.click()}
      >
        Attach
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
      {files.length === 0 && <span className="hint">or drop files here</span>}
    </div>
  );
}
