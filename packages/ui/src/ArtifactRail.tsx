import { Card, Collapse, DrawerRow, Empty, NavIcon } from "@kos/kit";
import { relativeWords, type ArtifactKind } from "@kos/shared";
import { useState, type ReactElement } from "react";

import type { PageSummary, Project } from "./api.js";
import { ProjectMark } from "./ProjectMark.js";

/**
 * The artifacts a project or a blob has, beside its chat: each one's kind,
 * title and when it changed, opening in place on a click. One that belongs
 * to another project (a blob works across several) says whose it is. Beside
 * the chat on a wide screen; on a narrow one, a row under the chat that
 * opens to the same list.
 */

const KIND_WORD: Record<ArtifactKind, string> = { page: "Page", doc: "Doc", deck: "Deck", sheet: "Sheet" };

export interface ArtifactRailProps {
  items: PageSummary[];
  /** The project the rail is beside; an artifact of any other says whose it is. */
  home?: string;
  projects: Project[];
  /** The artifact open in place now, marked in the list. */
  open?: string;
  onOpen: (item: PageSummary) => void;
}

function Rows({ items, home, projects, open, onOpen }: ArtifactRailProps): ReactElement {
  if (items.length === 0) return <Empty inline>No artifacts yet. Ask KOS for a doc, a deck, a sheet or a page.</Empty>;
  return (
    <ul className="artifact-rail" aria-label="Artifacts">
      {items.map((a) => {
        const owner = a.projectSlug && a.projectSlug !== home ? projects.find((p) => p.slug === a.projectSlug) : undefined;
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
              {a.projectSlug && a.projectSlug !== home && (
                <span className="artifact-rail-owner" title={`In ${owner?.name ?? a.projectSlug}`}>
                  <ProjectMark slug={a.projectSlug} name={owner?.name ?? a.projectSlug} colour={owner?.colour} />
                  <span>{owner?.name ?? a.projectSlug}</span>
                </span>
              )}
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
