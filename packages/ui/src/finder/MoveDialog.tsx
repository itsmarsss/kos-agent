import { useEffect, useState, type ReactElement } from "react";

import { Tooltip } from "@kos/kit";

import type { Project } from "../api.js";
import { Modal } from "../Modal.js";
import { ProjectMark } from "../ProjectMark.js";
import { nameOf, parentOf, within } from "./model.js";

/** A folder the dialog offers: not a hidden one (.kos), not inside what is moving. */
function offerable(folder: string, moving: string[]): boolean {
  if (folder !== "." && folder.split("/").some((s) => s.startsWith("."))) return false;
  return !moving.some((p) => within(folder, p));
}

/** A folder as the owner knows it: the workspace, a project by its name, else its path. */
function folderLabel(folder: string, projects: Project[]): { project?: Project; words: string } {
  if (folder === ".") return { words: "Workspace" };
  const [top, slug, ...rest] = folder.split("/");
  const project = top === "projects" && slug ? projects.find((p) => p.slug === slug) : undefined;
  if (!project) return { words: folder };
  return { project, words: [project.name, ...rest].join(" / ") };
}

/**
 * Move to…: the way to move without a drag (a phone, a keyboard): a folder
 * typed or picked from the places nearby, projects by their names, the
 * folder the items are in marked and not offered.
 */
export function MoveDialog({ paths, folders, projects, onMove, onClose }: { paths: string[] | null; folders: string[]; projects: Project[]; onMove: (dir: string) => void; onClose: () => void }): ReactElement {
  const [dir, setDir] = useState("");
  useEffect(() => setDir(""), [paths]);
  const moving = paths ?? [];
  const parents = new Set(moving.map(parentOf));
  const current = parents.size === 1 ? [...parents][0] : undefined;
  const offered = [...new Set(folders)].filter((f) => offerable(f, moving));
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
            {offered.map((f) => {
              const here = f === current;
              const { project, words } = folderLabel(f, projects);
              return (
                <button key={f} type="button" className="file-dialog-folder" aria-pressed={dir === f} disabled={here} onClick={() => setDir(f)}>
                  {project && <ProjectMark slug={project.slug} name={project.name} colour={project.colour} />}
                  <Tooltip tip={f === "." ? "The workspace's top folder" : f}>
                    <span className="file-dialog-folder-name">{words}</span>
                  </Tooltip>
                  {here && <span className="file-dialog-folder-here">here now</span>}
                </button>
              );
            })}
          </div>
        )}
        <div className="file-dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={dir.trim() !== "" && dir.trim().replace(/^\/+|\/+$/g, "") === current}>
            Move
          </button>
        </div>
      </form>
    </Modal>
  );
}
