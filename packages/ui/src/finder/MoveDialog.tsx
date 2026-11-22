import { useEffect, useState, type KeyboardEvent, type ReactElement } from "react";

import { Face, Field, NavIcon, PlacePicker, SheetFoot, type Place } from "@kos/kit";
import { slugWords } from "@kos/shared";

import type { Project } from "../api.js";
import { Modal } from "../Modal.js";
import { ProjectMark } from "../ProjectMark.js";
import { nameOf, parentOf, within } from "./model.js";

const FORM = "file-move-form";

/** A folder the dialog offers: not a hidden one (.kos), not inside what is moving. */
function offerable(folder: string, moving: string[]): boolean {
  if (folder !== "." && folder.split("/").some((s) => s.startsWith("."))) return false;
  return !moving.some((p) => within(folder, p));
}

/**
 * A folder as a place: the workspace, a project or a blob by its name (its
 * own folder), or a folder by its name with where it is under it, a project's
 * path said by the project's name. Never a slug.
 */
export function placeOf(folder: string, projects: readonly Project[]): Place {
  if (folder === ".") return { id: ".", name: "Workspace", group: "workspace", mark: <span className="tile artifact-move-ws" aria-hidden="true"><NavIcon name="files" /></span> };
  const [top, slug, ...rest] = folder.split("/");
  const project = top === "projects" && slug ? projects.find((p) => p.slug === slug) : undefined;
  if (project && rest.length === 0) return { id: folder, name: project.name, group: "project", mark: <ProjectMark slug={project.slug} name={project.name} colour={project.colour} /> };
  if (top === "blobs" && slug && rest.length === 0) return { id: folder, name: slugWords(slug), group: "blob", mark: <Face seed={slug} size={20} /> };
  const where = project ? [project.name, ...rest.slice(0, -1)] : folder.split("/").slice(0, -1);
  return { id: folder, name: nameOf(folder), group: "folder", ...(where.length ? { detail: `in ${where.join(" / ")}` } : { detail: "in Workspace" }) };
}

/**
 * Move to…: the way to move without a drag (a phone, a keyboard): the kit's
 * place picker, as an artifact's Move has it, the folder the items are in
 * marked and not offered, and a path for a folder further in.
 */
export function MoveDialog({ paths, folders, projects, onMove, onClose }: { paths: string[] | null; folders: string[]; projects: Project[]; onMove: (dir: string) => void; onClose: () => void }): ReactElement {
  const [dir, setDir] = useState("");
  useEffect(() => setDir(""), [paths]);
  const moving = paths ?? [];
  const parents = new Set(moving.map(parentOf));
  const current = parents.size === 1 ? [...parents][0] : undefined;
  const places = [...new Set(folders)]
    .filter((f) => offerable(f, moving))
    .map((f) => placeOf(f, projects))
    .sort((a, b) => a.name.localeCompare(b.name));
  const target = dir.trim().replace(/^\/+|\/+$/g, "");
  /**
   * The keys straight to a move: Enter on a place moves there; in the search,
   * Enter moves to the one place that matches (or goes to the first of
   * several), and the down arrow goes into the list.
   */
  const keys = (e: KeyboardEvent<HTMLDivElement>): void => {
    const el = e.target as HTMLElement;
    const open = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("[data-place]:not(:disabled)")];
    const top = open[0];
    if (e.key === "Enter" && el.dataset.place) {
      e.preventDefault();
      onMove(el.dataset.place);
      return;
    }
    if (el.tagName !== "INPUT" || !top) return;
    if (e.key === "ArrowDown" || (e.key === "Enter" && open.length > 1)) {
      e.preventDefault();
      setDir(top.dataset.place!);
      top.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      onMove(top.dataset.place!);
    }
  };
  const title = paths && paths.length === 1 ? `Move ${nameOf(paths[0]!)}` : `Move ${paths?.length ?? 0} items`;
  return (
    <Modal
      open={paths !== null}
      size="sm"
      title={title}
      onClose={onClose}
      footer={
        <SheetFoot
          onCancel={onClose}
          primary={
            <button type="submit" form={FORM} className="btn btn--primary" disabled={target === "" || target === current}>
              Move
            </button>
          }
        />
      }
    >
      <form
        id={FORM}
        className="file-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (target) onMove(target);
        }}
      >
        <div className="file-move-places" onKeyDown={keys}>
          <PlacePicker places={places} {...(current !== undefined ? { current } : {})} value={places.some((p) => p.id === target) ? target : null} onChoose={(id) => setDir(id ?? "")} />
        </div>
        <Field label="Or a folder by its path" hint="Further in than those above: projects/garden/notes.">
          <input className="kos-input ops-mono" value={places.some((p) => p.id === target) ? "" : dir} onChange={(e) => setDir(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}
