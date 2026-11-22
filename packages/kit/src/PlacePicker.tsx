import type { ReactElement, ReactNode } from "react";

/** One place something can live: the workspace, a project, a blob, a folder in one. */
export interface Place {
  id: string;
  /** The name the owner knows it by: "Reading log", "Plant watcher"; never its slug. */
  name: string;
  group: "workspace" | "project" | "blob" | "folder";
  /** Its mark: a project's tile, a blob's face, a folder's icon. */
  mark?: ReactNode;
  /** A line under the name: a folder's path inside its place. */
  detail?: string;
}

const GROUPS: readonly [Place["group"], string | null][] = [
  ["workspace", null],
  ["folder", "Folders"],
  ["project", "Projects"],
  ["blob", "Blobs"],
];

/**
 * Where to move something: one list of places in groups (the workspace,
 * folders, projects, blobs), each by its name with its mark, the one it is in
 * now marked "Here now" and not to be chosen. A file's Move and an
 * artifact's are this one picker.
 */
export function PlacePicker({ places, current, value, onChoose, label = "Move to" }: { places: readonly Place[]; current?: string; value: string | null; onChoose: (id: string) => void; label?: string }): ReactElement {
  return (
    <div className="place-picker" role="radiogroup" aria-label={label}>
      {GROUPS.map(([group, head]) => {
        const rows = places.filter((p) => p.group === group);
        if (rows.length === 0) return null;
        return (
          <div key={group} className="place-group" role="presentation">
            {head && <p className="place-group-head">{head}</p>}
            {rows.map((p) => {
              const here = p.id === current;
              return (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  className="place-row"
                  aria-checked={value === p.id}
                  disabled={here}
                  onClick={() => onChoose(p.id)}
                  title={p.detail ? `${p.name}, ${p.detail}` : p.name}
                >
                  {p.mark && <span className="place-mark">{p.mark}</span>}
                  <span className="place-words">
                    <span className="place-name">{p.name}</span>
                    {p.detail && <span className="place-detail">{p.detail}</span>}
                  </span>
                  {here && <span className="place-here">Here now</span>}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
