import { existsSync, mkdirSync, renameSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

/**
 * Where a download goes once it is done.
 *
 * Chrome drops files in a staging folder under names it made up. A file an
 * agent fetched belongs in the fetching chat's own folder (its project's or
 * its blob's), under a folder called downloads, under the name the site gave
 * it; one fetched at the root goes to a downloads folder at the workspace's
 * root. Either way it shows up in Files, and the thread says where it is.
 */

/** The name the site suggested, made safe to be a file name and nothing more. */
export function safeName(suggested: string): string {
  const name = basename(suggested.replace(/\\/g, "/")).replace(/[\u0000-\u001f<>:"|?*]/g, "_").trim();
  return name && name !== "." && name !== ".." ? name : "download";
}

/** The folder, workspace-relative, a conversation's downloads belong in, from its own folder ("" at the root). */
export function downloadsFolder(home: string): string {
  return home ? `${home.replace(/\/+$/, "")}/downloads` : "downloads";
}

/** A name in the folder nothing has yet: "report.pdf", then "report (2).pdf". */
export function uniquePath(folderAbs: string, name: string, exists: (p: string) => boolean = existsSync): string {
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  let candidate = name;
  for (let n = 2; exists(join(folderAbs, candidate)) && n < 1000; n++) candidate = `${stem} (${n})${ext}`;
  return join(folderAbs, candidate);
}

export interface SettledDownload {
  /** Workspace-relative, as a @file: mention would say it. */
  path: string;
  name: string;
}

/**
 * Move a finished download from staging into its place. Returns where it
 * ended up, workspace-relative. Throws if the staged file is not there.
 */
export function settleDownload(
  input: { workspaceRoot: string; stagingPath: string; suggestedFilename: string; home: string },
  fs: { exists?: (p: string) => boolean; mkdir?: (p: string) => void; rename?: (from: string, to: string) => void } = {},
): SettledDownload {
  const exists = fs.exists ?? existsSync;
  const mkdir = fs.mkdir ?? ((p: string) => mkdirSync(p, { recursive: true }));
  const rename = fs.rename ?? renameSync;
  if (!exists(input.stagingPath)) throw new Error(`downloaded file not found: ${input.stagingPath}`);
  const folder = downloadsFolder(input.home);
  const folderAbs = join(input.workspaceRoot, folder);
  mkdir(folderAbs);
  const target = uniquePath(folderAbs, safeName(input.suggestedFilename), exists);
  rename(input.stagingPath, target);
  const name = basename(target);
  return { path: `${folder}/${name}`, name };
}

/** Used by tests and by nothing else: the folder a target path sits in. */
export const folderOf = dirname;
