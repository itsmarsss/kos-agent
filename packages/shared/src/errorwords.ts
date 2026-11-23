/**
 * An error as the owner reads it. A tool's or the store's own message
 * ("ENOENT: no such file or directory, open '/Users/.../notes/x.md'",
 * "UNIQUE constraint failed: manifest.name") names the machinery and the
 * host's paths; this says what went wrong in a sentence and leaves the raw
 * text for Details.
 */

/** The last part of a path, for a sentence: never the host's folders above the workspace. */
function fileOf(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * Where a missing path was looked for: from the workspace down when the
 * workspace is known and holds it ("blobs/recap/notes/todo.md", which says
 * it looked in the blob's folder), else its last part alone.
 */
function missing(path: string, root: string | undefined): string {
  const base = root?.replace(/[\\/]+$/, "");
  const inside = base && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : null;
  return inside && inside.includes("/") ? `There is no file or folder at “${inside}”.` : `There is no file or folder called “${fileOf(path)}”.`;
}

const RULES: readonly [RegExp, (m: RegExpExecArray, root?: string) => string][] = [
  [/ENOENT[^']*'([^']+)'/, (m, root) => missing(m[1]!, root)],
  [/ENOENT/, () => "That file or folder is not there."],
  [/EACCES|EPERM/, () => "KOS isn't allowed to change that file."],
  [/EISDIR/, () => "That is a folder, not a file."],
  [/ENOTDIR/, () => "Part of that path is a file, not a folder."],
  [/EEXIST[^']*'([^']+)'/, (m) => `Something called “${fileOf(m[1]!)}” is already there.`],
  [/ENOSPC/, () => "The disk is full."],
  [/UNIQUE constraint failed/i, () => "That name is taken. Pick another."],
  [/no such table:\s*(\S+)/i, (m) => `There is no table called “${m[1]}”.`],
  [/no such column:\s*(\S+)/i, (m) => `There is no column called “${m[1]}”.`],
  [/SQLITE_BUSY|database is locked/i, () => "KOS was busy with something else. Try again in a moment."],
  [/invalid cron|not a valid cron/i, () => "That isn't a schedule KOS can read."],
  [/ETIMEDOUT|timed out|timeout/i, () => "It took too long and was stopped."],
  [/ECONNREFUSED|ENOTFOUND|fetch failed|EAI_AGAIN/i, () => "KOS couldn't reach it."],
  [/not on the allow(ed)? ?(list|hosts)|not one of the sites KOS may reach/i, () => "That site is not one of the sites KOS may reach."],
  [/^denied\b|denied by (you|the owner)|refused by the owner/i, () => "You said no to it."],
];

/** Internal prefixes that say nothing to the owner: "tool error:", "Error:". */
const PREFIX = /^(?:tool error|error|uncaught|typeerror|rangeerror)\s*:\s*/i;

/**
 * The sentence for an error: a known kind in plain words, else the text with
 * its machinery prefix gone and any absolute path cut to its last part.
 * Given the workspace's folder, a missing path is named from it down.
 */
export function errorWords(raw: string | null | undefined, opts: { root?: string } = {}): string {
  const text = (raw ?? "").trim();
  if (!text) return "Something went wrong.";
  for (const [re, say] of RULES) {
    const m = re.exec(text);
    if (m) return say(m, opts.root);
  }
  let plain = text;
  while (PREFIX.test(plain)) plain = plain.replace(PREFIX, "");
  plain = plain.replace(/(?:\/[^\s/'"]+){2,}\/([^\s/'"]+)/g, "$1");
  return plain ? plain[0]!.toUpperCase() + plain.slice(1) : "Something went wrong.";
}
