import type { ReactElement } from "react";

import type { DirEntry } from "../api.js";
import { FileIcon } from "../FileIcon.js";
import { Crumbs, pathWords } from "./Crumbs.js";
import { trail } from "./model.js";
import type { RowHandlers } from "./rows.js";

/**
 * Where the chosen thing is, at the foot: each folder on its way a step to
 * go to, and a place to drop on, cut from the left when it does not fit. A
 * count of what is here and chosen at the right.
 */
export function PathBar({ path, leaf, root, rootName, go, drop, over, status }: { path: string; leaf?: DirEntry; root: string; rootName: string; go: (dir: string) => void; drop: RowHandlers["drop"]; over: string | null; status: string }): ReactElement {
  const steps = trail(path, root, rootName);
  const items = [
    ...steps.map((s, i) => ({ key: s.path, name: s.name, icon: <FileIcon name={s.name} kind="dir" size={13} />, go: () => go(s.path), drop: drop(s.path), over: over === s.path, here: !leaf && i === steps.length - 1 })),
    ...(leaf ? [{ key: `leaf:${leaf.path}`, name: leaf.name, icon: <FileIcon name={leaf.name} kind={leaf.kind} size={13} />, here: true }] : []),
  ];
  return (
    <div className="finder-pathbar">
      <Crumbs items={items} label="Path" className="finder-path" title={pathWords(items.map((c) => c.name))} />
      <span className="finder-status">{status}</span>
    </div>
  );
}
