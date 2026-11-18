import type { ReactElement } from "react";

import { ChevronRight } from "@kos/kit";

import type { DirEntry } from "../api.js";
import { FileIcon } from "../FileIcon.js";
import { trail } from "./model.js";
import type { RowHandlers } from "./rows.js";

/**
 * Where the chosen thing is, at the foot: each folder on its way a step to
 * go to, and a place to drop on. A count of what is here and chosen at the
 * right.
 */
export function PathBar({ path, leaf, root, rootName, go, drop, over, status }: { path: string; leaf?: DirEntry; root: string; rootName: string; go: (dir: string) => void; drop: RowHandlers["drop"]; over: string | null; status: string }): ReactElement {
  const steps = trail(path, root, rootName);
  return (
    <div className="finder-pathbar">
      <nav className="finder-path" aria-label="Path">
        {steps.map((s, i) => (
          <span key={s.path} className="finder-path-step">
            {i > 0 && <ChevronRight size={10} title="" />}
            <button type="button" className={`${!leaf && i === steps.length - 1 ? "is-here" : ""}${over === s.path ? " is-drop" : ""}`} onClick={() => go(s.path)} {...drop(s.path)}>
              <FileIcon name={s.name} kind="dir" size={13} />
              {s.name}
            </button>
          </span>
        ))}
        {leaf && (
          <span className="finder-path-step">
            <ChevronRight size={10} title="" />
            <span className="finder-path-leaf">
              <FileIcon name={leaf.name} kind={leaf.kind} size={13} />
              {leaf.name}
            </span>
          </span>
        )}
      </nav>
      <span className="finder-status">{status}</span>
    </div>
  );
}
