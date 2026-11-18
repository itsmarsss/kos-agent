/**
 * A turn's file home: the folder its relative paths start from.
 *
 * A project's chats keep their files in the project's folder, a blob's own
 * thread in the blob's, and a chat at the root in the workspace itself. A
 * path is read from the home unless it says otherwise, so "bu252/notes.md"
 * from the school project is projects/school/bu252/notes.md. Reaching out
 * is deliberate: `workspace:` in front of a path reads it from the workspace
 * root, and a path that starts with one of KOS's own top-level folders
 * (projects/, blobs/, skills/...) names that folder wherever it is written.
 *
 * Pure and string-level, so the tools that act on a path and the step line
 * that narrates it place it by one rule. The jail still has the last word:
 * a placed path goes through resolvePath before anything touches it.
 */

/** Written in front of a path, it reads from the workspace root: `workspace:projects/resume/cv.md`. */
export const WORKSPACE_MARK = "workspace:";

/** Top-level folders of KOS's own layout: a path that starts with one names it, from any home. */
export const LAYOUT_FOLDERS: readonly string[] = ["projects", "blobs", "skills", "agents", "memory", "scratch"];

export interface FileHome {
  /** Workspace-relative folder, "" for the workspace root. */
  folder: string;
  /** Other folders that are the turn's own too: a blob working in a project keeps its notes in blobs/<name>. */
  also?: string[];
}

/** The workspace root as a home: every path is from the root, and nothing is outside it. */
export const ROOT_HOME: FileHome = { folder: "" };

export interface PlacedPath {
  /** Workspace-relative, "/"-separated, without leading or trailing slashes; "" is the root. An absolute path outside the root is left as written, for the jail to refuse. */
  path: string;
  /** Written from the workspace root rather than from the home. */
  explicit: boolean;
  /** Lands outside every folder the home owns. */
  outside: boolean;
}

const lower = (s: string): string => s.toLowerCase();

/** True when `path` is `folder` or inside it, compared without case: the disk may not tell them apart. */
export function inFolder(path: string, folder: string): boolean {
  if (folder === "") return true;
  const p = lower(path);
  const f = lower(folder);
  return p === f || p.startsWith(`${f}/`);
}

/** A home's own folders. */
function ownFolders(home: FileHome): string[] {
  return [home.folder, ...(home.also ?? [])];
}

/** True when a workspace path is outside every folder the home owns. */
export function outsideHome(home: FileHome, path: string): boolean {
  return home.folder !== "" && !ownFolders(home).some((f) => inFolder(path, f));
}

/** An absolute path with repeated slashes collapsed and "." steps dropped; ".." is kept for the jail to refuse. */
function normalAbsolute(path: string): string {
  return `/${path.split("/").filter((s) => s !== "" && s !== ".").join("/")}`;
}

/**
 * Where a path written by a turn with this home lands.
 *
 * - `workspace:<path>` is from the workspace root.
 * - An absolute path inside `root` (when the caller knows it) is that path.
 * - A path whose first folder is one of LAYOUT_FOLDERS is from the root:
 *   projects/school/x is never doubled into projects/school/projects/school/x.
 * - A path whose first folder is the home's own name is inside the home:
 *   "school/x" from projects/school is projects/school/x, the usual slip.
 * - Anything else is inside the home.
 */
export function placePath(home: FileHome, requested: string, root?: string): PlacedPath {
  let raw = requested.replace(/\\/g, "/").trim();
  let explicit = false;
  if (lower(raw).startsWith(WORKSPACE_MARK)) {
    raw = raw.slice(WORKSPACE_MARK.length).replace(/^\/+/, "");
    explicit = true;
  } else if (raw.startsWith("/")) {
    // Compared spelled one way: "//ws/x" and "/./ws/x" are /ws/x to the disk, and must be to the fence too.
    const absolute = normalAbsolute(raw);
    const base = root === undefined ? undefined : normalAbsolute(root.replace(/\\/g, "/"));
    // Not recognised as under the root: the jail refuses it or it lands somewhere unknown, never inside the home.
    if (!base || (absolute !== base && !absolute.startsWith(base === "/" ? "/" : `${base}/`))) return { path: requested, explicit: true, outside: home.folder !== "" };
    raw = absolute.slice(base.length);
    explicit = true;
  }
  const segments = raw.split("/").filter((s) => s !== "" && s !== ".");
  const first = segments[0] === undefined ? undefined : lower(segments[0]);
  const fromRoot = explicit || home.folder === "" || (first !== undefined && LAYOUT_FOLDERS.includes(first));
  const homeSegments = home.folder.split("/").filter(Boolean);
  const ownName = homeSegments.length ? lower(homeSegments[homeSegments.length - 1]!) : undefined;
  const parts = fromRoot ? segments : first === ownName ? [...homeSegments, ...segments.slice(1)] : [...homeSegments, ...segments];
  const path = parts.join("/");
  return { path, explicit: explicit || (fromRoot && home.folder !== ""), outside: outsideHome(home, path) };
}

/** What a path's first folders name, in words: "the resume project", "the blob noter", "skills/", "the workspace root". */
export function placeWords(path: string): string {
  const [top, next] = path.split("/");
  if (top === undefined || top === "") return "the workspace root";
  if (lower(top) === "projects" && next) return `the ${next} project`;
  if (lower(top) === "blobs" && next) return `the blob ${next}`;
  return path.includes("/") ? `${top}/` : "the workspace root";
}

/** The folder a read reaches into, as the step line names it: projects/resume, skills, the workspace root. */
function areaOf(path: string): string {
  const [top, next] = path.split("/");
  if (!top) return "the workspace root";
  if ((lower(top) === "projects" || lower(top) === "blobs") && next) return `${top}/${next}`;
  return path.includes("/") ? top : "the workspace root";
}

/** "this project" or "this blob's folder", for a home that is not the root. */
export function homeWords(home: FileHome): string {
  return lower(home.folder).startsWith("blobs/") ? "this blob's folder" : "this project";
}

/**
 * The words a step and its approval card carry for a path outside the home,
 * or nothing for one inside it. A read says where it reads from; a change
 * says it is outside, and whose folder it lands in.
 */
export function reachWords(home: FileHome, placed: PlacedPath, as: "read" | "change"): string | undefined {
  if (!placed.outside) return undefined;
  if (as === "read") return `reads from ${areaOf(placed.path)}`;
  return `outside ${homeWords(home)}, in ${placeWords(placed.path)}`;
}
