import type { ArtifactKind } from "@kos/shared";

import type { PageSummary } from "./api.js";

/**
 * Who an artifact is, in words, and whose it is: the pieces the gallery, its
 * dialogs, the rails and a chat's cards all name it by. Kept apart from the
 * gallery's page, so what the page draws can use them without importing it.
 */

/** An artifact's kind as a word, wherever one is named. */
export const KIND_WORD: Record<ArtifactKind, string> = { page: "Page", doc: "Doc", deck: "Deck", sheet: "Sheet" };

/** Who an artifact belongs to: a project, a blob, or the workspace (null). */
export type ArtifactOwner = { project: string } | { blob: string } | null;

export const ownerOf = (r: Pick<PageSummary, "projectSlug" | "blob">): ArtifactOwner => (r.blob ? { blob: r.blob } : r.projectSlug ? { project: r.projectSlug } : null);

/** The chat that answers for an artifact: its project's, its blob's thread, or KOS at the root (undefined). */
export const chatIdOf = (owner: ArtifactOwner): string | undefined => (!owner ? undefined : "project" in owner ? `project:${owner.project}` : `agent:${owner.blob}`);
