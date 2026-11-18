import type { ReactElement, ReactNode } from "react";

import { ClockIcon, DownloadIcon, NavIcon, UploadIcon } from "@kos/kit";

import type { Project } from "../api.js";
import { FileIcon } from "../FileIcon.js";
import { ProjectMark } from "../ProjectMark.js";
import type { RowHandlers } from "./rows.js";

/**
 * Where to go: the workspace and the places in it people go back to, each
 * project, and the trash. Each folder here takes a drop, as Finder's do; the
 * trash takes one too, and moves what was dropped into it.
 */

export type Place = { kind: "folder"; path: string } | { kind: "recents" } | { kind: "trash" };

export function samePlace(a: Place, b: Place): boolean {
  return a.kind === b.kind && (a.kind !== "folder" || a.path === (b as { path: string }).path);
}

export interface SidebarProps {
  place: Place;
  go: (place: Place) => void;
  /** Top-level folders that exist, for Downloads and Uploads. */
  top: string[];
  projects: Project[];
  drop: RowHandlers["drop"];
  over: string | null;
  /** A drop on the trash: what was dragged goes into it. */
  dropOnTrash: { onDragOver: (e: React.DragEvent) => void; onDragLeave: (e: React.DragEvent) => void; onDrop: (e: React.DragEvent) => void };
  trashOver: boolean;
}

function Item({ label, icon, current, onClick, drop, over }: { label: string; icon: ReactNode; current: boolean; onClick: () => void; drop?: ReturnType<RowHandlers["drop"]>; over?: boolean }): ReactElement {
  return (
    <button type="button" className={`finder-side-item${current ? " is-current" : ""}${over ? " is-drop" : ""}`} aria-current={current ? "location" : undefined} onClick={onClick} {...drop}>
      <span className="finder-side-icon">{icon}</span>
      <span className="finder-side-label">{label}</span>
    </button>
  );
}

export function Sidebar({ place, go, top, projects, drop, over, dropOnTrash, trashOver }: SidebarProps): ReactElement {
  const folder = (path: string, label: string, icon: ReactNode): ReactElement => (
    <Item key={path} label={label} icon={icon} current={samePlace(place, { kind: "folder", path })} onClick={() => go({ kind: "folder", path })} drop={drop(path)} over={over === path} />
  );
  return (
    <nav className="finder-side" aria-label="Locations">
      <p className="label finder-side-head">Favorites</p>
      {folder(".", "Workspace", <NavIcon name="files" />)}
      <Item label="Recents" icon={<ClockIcon />} current={place.kind === "recents"} onClick={() => go({ kind: "recents" })} />
      {top.includes("downloads") && folder("downloads", "Downloads", <DownloadIcon size={15} />)}
      {top.includes("uploads") && folder("uploads", "Uploads", <UploadIcon size={15} />)}
      {top.includes("projects") && folder("projects", "Projects", <NavIcon name="projects" />)}
      {projects.length > 0 && <p className="label finder-side-head">Projects</p>}
      {projects.map((p) => folder(`projects/${p.slug}`, p.name, <ProjectMark slug={p.slug} name={p.name} colour={p.colour} />))}
      <p className="label finder-side-head">Locations</p>
      {top.includes("blobs") && folder("blobs", "Blobs", <FileIcon name="blobs" kind="dir" size={15} />)}
      <Item label="Trash" icon={<NavIcon name="trash" />} current={place.kind === "trash"} onClick={() => go({ kind: "trash" })} drop={dropOnTrash} over={trashOver} />
    </nav>
  );
}
