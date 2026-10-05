import type { ProjectManifest } from "./manifest.js";
import type { Migrator } from "./migrate.js";
import type { PageStore } from "./pages.js";

export interface DeleteProjectResult {
  slug: string;
  tablesDropped: string[];
  pagesRemoved: number;
}

/**
 * Permanently delete a project and everything it owns: drop its tables, erase
 * its migration ledger, delete its page records and files, remove its folder,
 * and forget its manifest row.
 *
 * This is the destructive counterpart to project_create, and it is
 * irreversible: the rows go with the tables. Status "archived" is the
 * reversible option; this is not. Table ownership is the slug prefix and is
 * sibling-safe, so a second instance under a longer slug (pantry_2 beside
 * pantry) keeps its own tables. The manifest row is removed last, so the
 * sibling list is intact while the tables are chosen.
 *
 * What it does not touch: conversations. A chat that owns or discusses a
 * project outlives the project's data; archive or delete those separately.
 */
export function deleteProject(
  services: { manifest: ProjectManifest; migrator: Migrator; pages: PageStore },
  slug: string,
): DeleteProjectResult {
  const { manifest, migrator, pages } = services;
  if (!manifest.get(slug)) throw new Error(`unknown project: ${slug}`);
  const tablesDropped = migrator.dropProject(slug);
  const pagesRemoved = pages.removeProject(slug);
  manifest.remove(slug);
  return { slug, tablesDropped, pagesRemoved };
}
