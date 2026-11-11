import { NavIcon, Tag } from "@kos/kit";
import { isArtifactKind, type ArtifactKind } from "@kos/shared";
import { createContext, useContext, useEffect, useState, type ReactElement } from "react";

import type { ChatEvent, PageSummary, Project } from "./api.js";
import { KIND_WORD, OwnerMark, useDashboardTheme } from "./ArtifactsPage.js";
import { hrefFor } from "./routes.js";

/**
 * What a turn made, shown as what it is: when artifacts.write succeeds, the
 * transcript draws the artifact as a small card (its capture or its kind's
 * mark, title, kind and owner) with a way to open it, in place of the bare
 * step row. The step's arguments are the whole document, which no one reads
 * in a chat; the artifact is what the owner came for.
 */

/** Where a chat can open an artifact: on its own page, and here in place of the thread where the chat has room for one. */
export interface ArtifactOpeners {
  projects: Project[];
  open: (id: string) => void;
  /** In place of the thread, as the rail opens one; absent where the chat has no room for it. */
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

/** A string field of a record cut short, read from its JSON text where it survives: the record names its owner before its long fields. */
function cutField(raw: string, name: string): string | null | undefined {
  const m = new RegExp(`"${name}":(null|"((?:[^"\\\\]|\\\\.)*)")`).exec(raw);
  if (!m) return undefined;
  if (m[1] === "null") return null;
  try {
    return JSON.parse(`"${m[2]}"`) as string;
  } catch {
    return undefined;
  }
}

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
    // A record cut short in the transcript: what survives of it, then the arguments.
    for (const name of ["id", "title", "projectSlug", "blob", "artifactKind"]) {
      const v = cutField(event.result, name);
      if (v !== undefined) kept[name] = v;
    }
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
    projectSlug: text(kept.projectSlug) ?? (blob || kept.projectSlug === null ? null : text(asked.project) ?? null),
    ...(blob ? { blob } : {}),
    ...(typeof kept.updatedAt === "number" ? { updatedAt: kept.updatedAt } : {}),
  };
}

/** How long after a capture was missing it is asked for once more: artifacts.check usually runs just after the write. */
export const THUMB_RETRY_MS = 8000;

export function ArtifactStep({ art }: { art: WrittenArtifact }): ReactElement {
  const { projects, open, beside } = useContext(ArtifactOpen);
  const theme = useDashboardTheme();
  /*
   * The capture artifacts.check keeps, in the dashboard's palette; the
   * kind's mark until there is one. A capture missing at first (the check
   * runs after the write) is asked for once more a little later, and again
   * when the palette changes.
   */
  const [tries, setTries] = useState(0);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    setTries(0);
    setMissing(false);
  }, [theme, art.id, art.updatedAt]);
  useEffect(() => {
    if (!missing || tries > 0) return;
    const later = setTimeout(() => {
      setTries(1);
      setMissing(false);
    }, THUMB_RETRY_MS);
    return () => clearTimeout(later);
  }, [missing, tries]);
  return (
    <div className="artifact-step">
      <button type="button" className="artifact-step-thumb" data-kind={art.artifactKind} tabIndex={-1} aria-hidden="true" onClick={() => open(art.id)}>
        {!missing ? (
          <img src={`/api/artifacts/${encodeURIComponent(art.id)}/thumb?theme=${theme}&v=${Math.round(art.updatedAt ?? 0)}&try=${tries}`} alt="" loading="lazy" onError={() => setMissing(true)} />
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
            Open here
          </button>
        )}
        <button type="button" className="btn btn--sm" onClick={() => open(art.id)}>
          Open
        </button>
      </span>
    </div>
  );
}
