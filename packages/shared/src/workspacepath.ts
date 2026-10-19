/**
 * A workspace path as a step names it: one of the workspace's own folders,
 * then the rest of the path. Not preceded by a letter, a slash, a bracket,
 * an at sign or a colon, so a path inside a reference or a link already
 * made is left alone; trailing punctuation stays outside.
 */
const WORKSPACE_PATH = /(?<![\w/@[(<:])((?:projects|blobs|uploads|memory|skills|agents|workspace|exports)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)(?![\w/])/g;

/** A run of text, or a path in it: what a renderer links. */
export interface PathPart {
  text: string;
  /** Set when the run is a workspace path. */
  path?: string;
}

/** The text split into plain runs and the workspace paths in it, in order. */
export function pathsIn(text: string): PathPart[] {
  const out: PathPart[] = [];
  let at = 0;
  for (const m of text.matchAll(WORKSPACE_PATH)) {
    const found = m[0];
    const trail = /[.,;:!?]*$/.exec(found)?.[0] ?? "";
    const path = found.slice(0, found.length - trail.length);
    const start = m.index ?? 0;
    if (start > at) out.push({ text: text.slice(at, start) });
    out.push({ text: path, path });
    if (trail) out.push({ text: trail });
    at = start + found.length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}
