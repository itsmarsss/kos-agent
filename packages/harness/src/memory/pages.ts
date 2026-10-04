import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Db } from "../store/db.js";
import { GLOBAL_SCOPE, projectScope, type FactsStore } from "./facts.js";

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


/**
 * The pages as last written, so an owner's edit can be told from the
 * dream job's own rewrite. A page line of the form `- key: value` is a
 * claim in the page's scope; an edited line comes back in as the owner's
 * word, which outranks anything the job believed.
 */
export class PageLog {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS memory_pages (name TEXT PRIMARY KEY, hash TEXT NOT NULL, written_at INTEGER NOT NULL)`);
  }

  record(name: string, markdown: string): void {
    this.db.prepare(`INSERT INTO memory_pages (name, hash, written_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET hash = excluded.hash, written_at = excluded.written_at`)
      .run(name, hashOf(markdown), this.now());
  }

  recorded(name: string): string | undefined {
    const r = this.db.prepare(`SELECT hash FROM memory_pages WHERE name = ?`).get(name) as { hash: string } | undefined;
    return r?.hash;
  }

  /** Pages on disk that differ from what was last written: the owner's edits, or a page they made. */
  edited(ws: Workspace): string[] {
    return listPages(ws)
      .filter((p) => hashOf(readPage(ws, p.name) ?? "") !== this.recorded(p.name))
      .map((p) => p.name);
  }
}

function hashOf(markdown: string): string {
  return createHash("sha256").update(markdown.endsWith("\n") ? markdown : `${markdown}\n`).digest("hex");
}

export const CLAIM_LINE = /^\s*[-*]\s+([a-z0-9][a-z0-9_]{0,59})\s*:\s+(.+?)\s*$/;

/** The scope a page's lines belong to: profile is the owner everywhere, any other name is a project. */
export function pageScope(name: string): string {
  return name === "profile" ? GLOBAL_SCOPE : projectScope(name);
}

export interface PageImport {
  name: string;
  scope: string;
  /** Keys written or changed from the page. */
  imported: string[];
  /** Claim lines whose value the store already had. */
  unchanged: number;
}

/** Read a page's claim lines back into memory as the owner's word, and note the page as read. */
export function importPage(ws: Workspace, facts: FactsStore, log: PageLog, ownerId: string, name: string): PageImport {
  const text = readPage(ws, name);
  if (text === undefined) throw new Error(`no page named ${name}`);
  const scope = pageScope(name);
  const imported: string[] = [];
  let unchanged = 0;
  for (const line of text.split("\n")) {
    const m = CLAIM_LINE.exec(line);
    if (!m) continue;
    const [, key, value] = m;
    const current = facts.get(ownerId, key!, scope);
    if (current && current.value === value) {
      unchanged++;
      continue;
    }
    facts.upsert(ownerId, { key: key!, value: value!, kind: current?.kind ?? "fact", scope, trust: "owner" }, `page:${name}`);
    imported.push(key!);
  }
  log.record(name, text);
  return { name, scope, imported, unchanged };
}
