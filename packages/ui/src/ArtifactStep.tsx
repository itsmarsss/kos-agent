import { NavIcon, Tag } from "@kos/kit";
import { isArtifactKind, type ArtifactKind } from "@kos/shared";
import { createContext, useContext, useState, type ReactElement } from "react";

import type { ChatEvent, PageSummary, Project } from "./api.js";
import { KIND_WORD, OwnerMark } from "./ArtifactsPage.js";
import { hrefFor } from "./routes.js";

/**
 * What a turn made, shown as what it is: when artifacts.write succeeds, the
 * transcript draws the artifact as a small card (its capture or its kind's
 * mark, title, kind and owner) with a way to open it, in place of the bare
 * step row. The step's arguments are the whole document, which no one reads
 * in a chat; the artifact is what the owner came for.
 */

/** Where a chat can open an artifact: on its own page, and beside the thread where the chat has room for one. */
export interface ArtifactOpeners {
  projects: Project[];
  open: (id: string) => void;
  /** In place of the thread, as the rail opens one; absent where the chat has nowhere beside it. */
  beside?: (id: string) => void;
}

const onItsPage: ArtifactOpeners = {
  projects: [],
  open: (id) => {
    window.location.hash = hrefFor({ name: "artifacts", id });
  },
};

export const ArtifactOpen = createContext<ArtifactOpeners>(onItsPage);

/** The artifact a step wrote, as the transcript can tell it. */
export type WrittenArtifact = Pick<PageSummary, "id" | "title" | "projectSlug" | "blob"> & { artifactKind: ArtifactKind; updatedAt?: number };

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/**
 * The artifact an artifacts.write step wrote: from its result (the record the
 * store kept), else from what it was asked to write. Nothing for any other
 * step, one still running, held for approval or failed, or a write that
 * names no id and title.
 */
export function writtenArtifact(event: Extract<ChatEvent, { kind: "tool" }>): WrittenArtifact | undefined {
  if (event.name !== "artifacts.write" || event.result === undefined || event.isError || event.pendingId !== undefined) return undefined;
  // What the store kept is a record; anything else (a refusal in words) is no artifact.
  if (!event.result.trimStart().startsWith("{")) return undefined;
  let kept: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(event.result);
    if (parsed && typeof parsed === "object") kept = parsed as Record<string, unknown>;
  } catch {
    // A record cut short in the transcript: the arguments still name it.
  }
  const asked = event.args;
  const id = text(kept.id) ?? text(asked.id);
  const title = text(kept.title) ?? text(asked.title);
  if (!id || !title) return undefined;
  const kind = kept.artifactKind ?? asked.kind;
  const blob = text(kept.blob);
  return {
    id,
    title,
    artifactKind: isArtifactKind(kind) ? kind : "page",
    projectSlug: text(kept.projectSlug) ?? null,
    ...(blob ? { blob } : {}),
    ...(typeof kept.updatedAt === "number" ? { updatedAt: kept.updatedAt } : {}),
  };
}

/** The dashboard's palette now, for the capture drawn in it. */
const theme = (): "light" | "dark" => (document.documentElement.dataset.theme === "light" ? "light" : "dark");

export function ArtifactStep({ art }: { art: WrittenArtifact }): ReactElement {
  const { projects, open, beside } = useContext(ArtifactOpen);
  // The capture artifacts.check keeps, when it has one; the kind's mark until then.
  const [capture, setCapture] = useState(true);
  return (
    <div className="artifact-step">
      <button type="button" className="artifact-step-thumb" data-kind={art.artifactKind} tabIndex={-1} aria-hidden="true" onClick={() => open(art.id)}>
        {capture ? (
          <img src={`/api/artifacts/${encodeURIComponent(art.id)}/thumb?theme=${theme()}&v=${Math.round(art.updatedAt ?? 0)}`} alt="" loading="lazy" onError={() => setCapture(false)} />
        ) : (
          <NavIcon name={art.artifactKind} />
        )}
      </button>
      <span className="artifact-step-body">
        <span className="artifact-step-title">{art.title}</span>
        <span className="artifact-step-meta">
          <Tag>{KIND_WORD[art.artifactKind]}</Tag>
          <span className="artifact-step-owner">
            <OwnerMark record={art} projects={projects} />
          </span>
        </span>
      </span>
      <span className="artifact-step-acts">
        {beside && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => beside(art.id)}>
            Open beside
          </button>
        )}
        <button type="button" className="btn btn--sm" onClick={() => open(art.id)}>
          Open
        </button>
      </span>
    </div>
  );
}
