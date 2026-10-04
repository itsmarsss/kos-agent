import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Workspace } from "../store/workspace.js";

/**
 * Pages: memory the owner can read.
 *
 * Claims are rows; a page is prose. The dream job writes one per project
 * and per topic under memory/, rendered from the claims, so the owner can
 * open a file and see what KOS believes about a thing without reading a
 * table. The claims stay the source of truth; a page is a view of them.
 */

export const PAGES_DIR = "memory";
export const PAGE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface PageInfo {
  name: string;
  /** Workspace-relative path. */
  path: string;
  updatedAt: number;
  bytes: number;
}

export function writePage(ws: Workspace, name: string, markdown: string): PageInfo {
  if (!PAGE_NAME.test(name)) throw new Error(`not a page name: ${name}`);
  const dir = ws.resolve(PAGES_DIR);
  mkdirSync(dir, { recursive: true });
  const rel = `${PAGES_DIR}/${name}.md`;
  const abs = ws.resolve(rel);
  writeFileSync(abs, markdown.endsWith("\n") ? markdown : `${markdown}\n`, "utf8");
  const st = statSync(abs);
  return { name, path: rel, updatedAt: st.mtimeMs, bytes: st.size };
}

export function readPage(ws: Workspace, name: string): string | undefined {
  if (!PAGE_NAME.test(name)) throw new Error(`not a page name: ${name}`);
  const abs = ws.resolve(`${PAGES_DIR}/${name}.md`);
  return existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
}

export function listPages(ws: Workspace): PageInfo[] {
  const dir = ws.resolve(PAGES_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && PAGE_NAME.test(f.slice(0, -3)))
    .sort()
    .map((f) => {
      const st = statSync(join(dir, f));
      return { name: f.slice(0, -3), path: `${PAGES_DIR}/${f}`, updatedAt: st.mtimeMs, bytes: st.size };
    });
}
