import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

/**
 * Searching the workspace without ripgrep.
 *
 * search.grep shelled out to ripgrep and failed outright when it was not
 * installed, which is a core capability going missing based on what the owner
 * happens to have on their machine. The agent has no way to know in advance,
 * so it tries, fails, and works around it badly.
 *
 * This is slower than ripgrep and is not trying to replace it: ripgrep is
 * still used when it is there. It exists so that "search the workspace" always
 * means something.
 */

/** Directories never worth searching, matching the mention index's list. */
const SKIP_DIRS = new Set([
  "node_modules",
  "__pycache__",
  "site-packages",
  "venv",
  "env",
  "dist",
  "build",
  "target",
  "vendor",
  "coverage",
  "out",
  ".git",
]);

/**
 * Extensions read as text. Everything else is skipped rather than scanned:
 * grepping a binary produces noise, and ripgrep skips them too.
 */
const TEXT = new Set([
  ".txt", ".md", ".markdown", ".json", ".jsonl", ".csv", ".tsv", ".yaml", ".yml",
  ".toml", ".ini", ".env", ".log", ".sql", ".js", ".mjs", ".cjs", ".ts", ".tsx",
  ".jsx", ".css", ".scss", ".html", ".htm", ".xml", ".svg", ".sh", ".bash",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift", ".c", ".h", ".cpp",
  ".hpp", ".cs", ".php", ".pl", ".lua", ".r", ".conf", ".cfg", ".gitignore",
  ".tex", ".rst", ".vue", ".svelte", ".astro",
]);

/** Files read per search, so one call cannot walk a huge tree forever. */
const MAX_FILES = 5000;
/** Matches returned, matching what a reader can use. */
const MAX_MATCHES = 500;
/** Files larger than this are skipped: a grep hit in a 50MB file helps nobody. */
const MAX_BYTES = 2_000_000;

export interface ScanResult {
  lines: string[];
  /** True when the walk stopped early, so the caller can say so. */
  truncated: boolean;
}

function isText(name: string): boolean {
  const ext = extname(name).toLowerCase();
  if (ext === "") return true; // Makefile, Dockerfile, LICENSE and friends.
  return TEXT.has(ext);
}

/**
 * Search a directory tree for a pattern, in ripgrep's output shape:
 * `path:line:text`, paths relative to the workspace root.
 */
export function scan(
  root: string,
  target: string,
  pattern: string,
  options: { maxMatches?: number; maxFiles?: number } = {},
): ScanResult {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (err) {
    throw new Error(
      `not a valid pattern: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const maxMatches = options.maxMatches ?? MAX_MATCHES;
  const maxFiles = options.maxFiles ?? MAX_FILES;
  const lines: string[] = [];
  let files = 0;
  let truncated = false;

  const search = (file: string): void => {
    let text: string;
    try {
      if (statSync(file).size > MAX_BYTES) return;
      text = readFileSync(file, "utf8");
    } catch {
      // Unreadable, vanished, or not really text. Not an error for a search.
      return;
    }
    // A NUL byte means binary whatever the extension claimed.
    if (text.includes("\0")) return;

    const rel = relative(root, file);
    const split = text.split("\n");
    for (let i = 0; i < split.length; i++) {
      if (lines.length >= maxMatches) {
        truncated = true;
        return;
      }
      const line = split[i]!;
      if (regex.test(line)) {
        // Long lines are trimmed: a minified bundle would otherwise fill the
        // whole result with one match.
        lines.push(`${rel}:${i + 1}:${line.slice(0, 500)}`);
      }
    }
  };

  const walk = (dir: string): void => {
    if (files >= maxFiles || lines.length >= maxMatches) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files >= maxFiles || lines.length >= maxMatches) {
        truncated = true;
        return;
      }
      if (entry.name.startsWith(".") && entry.name !== ".env") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile() && isText(entry.name)) {
        files += 1;
        search(full);
      }
    }
  };

  let stats;
  try {
    stats = statSync(target);
  } catch {
    return { lines: [], truncated: false };
  }
  if (stats.isFile()) {
    files += 1;
    search(target);
  } else {
    walk(target);
  }

  return { lines, truncated };
}
