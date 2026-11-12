import { NavIcon } from "@kos/kit";
import { relativeWords } from "@kos/shared";
import type { ReactElement } from "react";

import type { ArtifactSummary } from "./api.js";
import { deleteWords, type ArtifactOps } from "./ArtifactManage.js";
import { ConfirmButton } from "./kit.js";

/**
 * The trash as a list: what each one is, whose it was and when it went, with
 * Restore and Delete forever on its row. A row opens it, to look at before
 * deciding. Nothing leaves on its own.
 */
export function TrashList({
  items,
  theme,
  ops,
  kindOf,
  owner,
  onOpen,
}: {
  items: ArtifactSummary[];
  theme: "light" | "dark";
  ops: Pick<ArtifactOps, "restore" | "remove" | "busy">;
  /** The kind as a word: Doc, Deck, or Widgets for an older widget page. */
  kindOf: (a: ArtifactSummary) => string;
  owner: (a: ArtifactSummary) => ReactElement;
  onOpen: (id: string) => void;
}): ReactElement {
  return (
    <ul className="trash-list" aria-label="Trash">
      {items.map((a) => (
        <li key={a.id} className="trash-row">
          <button type="button" className="trash-row-open" onClick={() => onOpen(a.id)}>
            <span className="trash-thumb" aria-hidden="true">
              {a.capturedAt ? (
                <img src={`/api/artifacts/${encodeURIComponent(a.id)}/thumb?theme=${theme}&v=${Math.round(a.capturedAt)}`} alt="" loading="lazy" />
              ) : (
                <NavIcon name={a.artifactKind} />
              )}
            </span>
            <span className="trash-row-text">
              <span className="artifact-card-title">{a.title}</span>
              <span className="artifact-card-meta">
                <span>{kindOf(a)}</span>
                <span className="artifact-card-owner">{owner(a)}</span>
                <span className="artifact-card-time" title="When it was moved to the trash">
                  {relativeWords(Math.round((a.trashedAt ?? a.updatedAt) / 1000))}
                </span>
              </span>
            </span>
          </button>
          <span className="trash-row-acts">
            <button type="button" className="btn btn--sm" disabled={ops.busy} onClick={() => ops.restore(a)} aria-label={`Restore ${a.title}`}>
              Restore
            </button>
            <ConfirmButton className="btn btn--sm btn--ghost trash-delete" label="Delete forever" title={`Delete ${a.title} forever`} text={deleteWords(a.title)} disabled={ops.busy} onConfirm={() => ops.remove(a)} />
          </span>
        </li>
      ))}
    </ul>
  );
}
