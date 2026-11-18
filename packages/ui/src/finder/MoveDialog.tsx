import { useEffect, useState, type ReactElement } from "react";

import { Modal } from "../Modal.js";
import { nameOf, within } from "./model.js";

/**
 * Move to…: the way to move without a drag (a phone, a keyboard): a folder
 * typed or picked from the places nearby.
 */
export function MoveDialog({ paths, folders, onMove, onClose }: { paths: string[] | null; folders: string[]; onMove: (dir: string) => void; onClose: () => void }): ReactElement {
  const [dir, setDir] = useState("");
  useEffect(() => setDir(""), [paths]);
  const offered = [...new Set(folders)].filter((f) => !(paths ?? []).some((p) => within(f, p)));
  const title = paths && paths.length === 1 ? `Move ${nameOf(paths[0]!)}` : `Move ${paths?.length ?? 0} items`;
  return (
    <Modal open={paths !== null} size="sm" title={title} onClose={onClose}>
      <form
        className="file-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          onMove(dir.trim().replace(/^\/+|\/+$/g, "") || ".");
        }}
      >
        <label className="file-dialog-label">
          Into folder
          <input className="kos-input ops-mono" value={dir} autoFocus placeholder="projects/garden/notes" onChange={(e) => setDir(e.target.value)} />
        </label>
        {offered.length > 0 && (
          <div className="file-dialog-folders">
            {offered.map((f) => (
              <button key={f} type="button" className="file-dialog-folder" aria-pressed={dir === f} onClick={() => setDir(f)}>
                {f === "." ? "Workspace" : f}
              </button>
            ))}
          </div>
        )}
        <div className="file-dialog-actions">
          <button type="submit" className="btn btn--primary">
            Move
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
