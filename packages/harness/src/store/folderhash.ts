import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * The hash of a folder of code as the owner approved it: every path, every
 * file's bytes and every link's target as written, so anything added,
 * removed or changed is different code. A link is hashed by the name of its
 * target and never followed (pnpm's node_modules are links); what it names
 * outside the folder is the jail's to guard. .git runs nothing and is left
 * out, as are the folder's own top-level names in `skip`: what the code
 * itself writes, or KOS writes beside it.
 */

/** Each file's content hash, kept while its size and modification time stand, so a large node_modules is read once. */
const fileHashes = new Map<string, { size: number; mtimeMs: number; hash: string }>();

function fileHash(abs: string): string {
  const st = lstatSync(abs);
  const known = fileHashes.get(abs);
  if (known && known.size === st.size && known.mtimeMs === st.mtimeMs) return known.hash;
  const hash = createHash("sha256").update(readFileSync(abs)).digest("hex");
  fileHashes.set(abs, { size: st.size, mtimeMs: st.mtimeMs, hash });
  return hash;
}

/** The hash of `dir`, an absolute folder already resolved through the jail. */
export function folderHash(dir: string, skip: readonly string[] = []): string {
  const hash = createHash("sha256");
  const walk = (rel: string): void => {
    const names = readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of names) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      const abs = join(dir, path);
      if (entry.isDirectory()) {
        if (entry.name !== ".git" && !(rel === "" && skip.includes(entry.name))) walk(path);
      } else if (entry.isSymbolicLink()) {
        hash.update(`link\0${path}\0${readlinkSync(abs)}\0`);
      } else if (entry.isFile()) {
        if (!(rel === "" && skip.includes(entry.name))) hash.update(`file\0${path}\0${fileHash(abs)}\0`);
      } else {
        throw new Error(`${path} is not a plain file, folder or link`);
      }
    }
  };
  walk("");
  return hash.digest("hex");
}
