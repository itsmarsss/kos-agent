import { Card, Collapse, DrawerRow, Empty, NavIcon } from "@kos/kit";
import { relativeWords } from "@kos/shared";
import { useEffect, useState, type ReactElement } from "react";

import { api, type PageSummary } from "./api.js";
import { KIND_WORD } from "./ArtifactsPage.js";
import { onTurnEnd } from "./progress.js";

/**
 * The artifacts a project or a blob owns, beside its chat: each one's kind,
 * title and when it changed, opening in place on a click. Beside the chat on
 * a wide screen; on a narrow one, a row under the chat that opens to the same
 * list.
 */

/** Whose rail it is: a project's, by its slug, or a blob's, by its name. */
export type RailOwner = { project: string } | { blob: string };

/** What an owner owns: a blob's own, or a project's that no blob owns. */
export const ownedBy = (owner: RailOwner, a: Pick<PageSummary, "projectSlug" | "blob">): boolean =>
  "blob" in owner ? a.blob === owner.blob : a.projectSlug === owner.project && !a.blob;

/**
 * An owner's artifacts, newest first. Read when the owner changes, when
 * `again` does (what is open in place was closed or changed), and when a turn
 * ends, since a turn is what makes one.
 */
export function useOwnedArtifacts(owner: RailOwner | undefined, again?: unknown): PageSummary[] {
  const [items, setItems] = useState<PageSummary[]>([]);
  const key = owner ? ("blob" in owner ? `blob:${owner.blob}` : `project:${owner.project}`) : "";
  // Another owner's list is not shown while this one's is read.
  useEffect(() => setItems([]), [key]);
  useEffect(() => {
    if (!owner) return;
    let stale = false;
    const read = (): void =>
      void api
        .artifacts()
        .then((list) => !stale && setItems(list.filter((a) => ownedBy(owner, a)).sort((a, b) => b.updatedAt - a.updatedAt)))
        .catch(() => undefined);
    read();
    const stop = onTurnEnd(read);
    return () => {
      stale = true;
      stop();
    };
  }, [key, again]);
  return items;
}

export interface ArtifactRailProps {
  items: PageSummary[];
  /** The artifact open in place now, marked in the list. */
  open?: string;
  onOpen: (item: PageSummary) => void;
}

function Rows({ items, open, onOpen }: ArtifactRailProps): ReactElement {
  if (items.length === 0) return <Empty inline>No artifacts yet. Ask KOS for a doc, a deck, a sheet or a page.</Empty>;
  return (
    <ul className="artifact-rail" aria-label="Artifacts">
      {items.map((a) => {
        const kind = a.kind === "html" ? KIND_WORD[a.artifactKind] : "Widget page";
        return (
          <li key={a.id}>
            <button type="button" className={`artifact-rail-row${a.id === open ? " is-on" : ""}`} aria-current={a.id === open ? "true" : undefined} onClick={() => onOpen(a)}>
              <span className="tile" data-tone="muted" aria-hidden="true">
                <NavIcon name={a.artifactKind} />
              </span>
              <span className="line-text">
                <strong>{a.title}</strong>
                <span>
                  {kind}, {relativeWords(Math.round(a.updatedAt / 1000))}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The list as a card, for the panel beside the chat. */
export function ArtifactRail(props: ArtifactRailProps): ReactElement {
  return (
    <Card className="project-panel-section" title="Artifacts" count={props.items.length}>
      <Rows {...props} />
    </Card>
  );
}

/** The list folded into one row, for under the chat on a narrow screen. */
export function ArtifactStrip(props: ArtifactRailProps): ReactElement | null {
  const [open, setOpen] = useState(false);
  if (props.items.length === 0) return null;
  const latest = props.items[0]!;
  return (
    <div className="artifact-strip">
      <DrawerRow
        icon={<NavIcon name="artifacts" />}
        tone="muted"
        title={`Artifacts (${props.items.length})`}
        detail={`Latest: ${latest.title}`}
        open={open}
        onToggle={() => setOpen((v) => !v)}
      />
      <Collapse open={open}>
        <Rows
          {...props}
          onOpen={(a) => {
            setOpen(false);
            props.onOpen(a);
          }}
        />
      </Collapse>
    </div>
  );
}
