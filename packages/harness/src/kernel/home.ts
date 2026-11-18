import { ROOT_HOME, WORKSPACE_MARK, type FileHome } from "@kos/shared";

/**
 * The folder a conversation's files belong in: its project's, else its
 * blob's, else the workspace root. A blob dispatched into a project works
 * for the project, so the project's folder is its home there and its own
 * folder stays its own beside it. Uploads, downloads and every relative
 * path a file tool is given start here.
 */
export function fileHomeOf(conversation: { projectSlug: string | null; role: string | null } | undefined, roleFolder?: string): FileHome {
  const blob = conversation?.role && roleFolder ? roleFolder.replace(/\/+$/, "") : undefined;
  if (conversation?.projectSlug) return { folder: `projects/${conversation.projectSlug}`, ...(blob ? { also: [blob] } : {}) };
  return blob ? { folder: blob } : ROOT_HOME;
}

/**
 * What a turn with a home other than the root is told about it, for its
 * system prompt on both engines: where its files go, that a relative path
 * is inside it, and how to reach elsewhere on purpose. Nothing at the root,
 * where every path already is the workspace's.
 */
export function homeNote(home: FileHome): string | undefined {
  if (home.folder === "") return undefined;
  const own = home.folder.split("/").pop();
  const whose = home.folder.startsWith("projects/") ? "this project's folder" : "your own folder";
  return [
    "## Your files",
    `Your files live in ${home.folder}/, ${whose}. Every relative path you give a file tool is inside it: files.write with path "notes/plan.md" writes ${home.folder}/notes/plan.md, files.ls with no path lists it, and shell.run and python.run start there. Never begin a path with "${own}/" or "workspace/" to mean this folder; a relative path already is.`,
    ...(home.also?.length ? [`Your notes folder, ${home.also.join(", ")}/, is yours too: write it as ${home.also[0]}/<file>.`] : []),
    `To reach anywhere else, write the path from the workspace root: ${WORKSPACE_MARK}<path> (${WORKSPACE_MARK}projects/other/notes.md), or a path that starts with one of KOS's own folders (projects/, blobs/, skills/, scratch/). Reading elsewhere is fine; writing, moving or deleting outside ${home.folder}/ asks the owner first, so do it only when the owner wants the file there.`,
    "Tool results name files by their workspace path (projects/...), which works as a path from here and in @file: references.",
  ].join("\n");
}
