import { createHash, randomBytes } from "node:crypto";

import type { Db } from "../store/db.js";

/**
 * Callers: other programs that share KOS's memory, within a grant.
 *
 * A caller is a name and a token. It owns a scope of its own, caller:<name>,
 * which it may read and write freely. Of the owner's global memory it may
 * read only the tags it was granted, and write global only if the grant
 * says so. The grant is the owner's, managed like a permission; the token
 * is shown once and kept hashed. Nothing here lets a caller see another
 * caller's scope or any project's.
 */

export interface Caller {
  id: number;
  name: string;
  /** Global tags it may read; "*" for all. */
  readTags: string[];
  writeGlobal: boolean;
  createdAt: number;
  lastSeenAt: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_callers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL,
  read_tags TEXT NOT NULL,
  write_global INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);
`;

export const CALLER_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

interface Row {
  id: number;
  name: string;
  token_hash: string;
  read_tags: string;
  write_global: number;
  created_at: number;
  last_seen_at: number | null;
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function toCaller(r: Row): Caller {
  return { id: r.id, name: r.name, readTags: JSON.parse(r.read_tags) as string[], writeGlobal: r.write_global === 1, createdAt: r.created_at, lastSeenAt: r.last_seen_at };
}

export class CallerStore {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {
    this.db.exec(SCHEMA);
  }

  /** Make a caller. The token comes back once; only its hash is kept. */
  create(name: string, grant: { readTags?: string[]; writeGlobal?: boolean } = {}): { caller: Caller; token: string } {
    if (!CALLER_NAME.test(name)) throw new Error(`not a caller name: ${name}`);
    if (this.byName(name)) throw new Error(`a caller named ${name} already exists`);
    const token = `kosc_${randomBytes(24).toString("base64url")}`;
    const tags = [...new Set((grant.readTags ?? []).map((t) => t.trim()).filter(Boolean))];
    const info = this.db
      .prepare(`INSERT INTO memory_callers (name, token_hash, read_tags, write_global, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(name, hash(token), JSON.stringify(tags), grant.writeGlobal ? 1 : 0, this.now());
    return { caller: this.get(Number(info.lastInsertRowid))!, token };
  }

  get(id: number): Caller | undefined {
    const r = this.db.prepare(`SELECT * FROM memory_callers WHERE id = ?`).get(id) as Row | undefined;
    return r ? toCaller(r) : undefined;
  }

  byName(name: string): Caller | undefined {
    const r = this.db.prepare(`SELECT * FROM memory_callers WHERE name = ?`).get(name) as Row | undefined;
    return r ? toCaller(r) : undefined;
  }

  list(): Caller[] {
    return (this.db.prepare(`SELECT * FROM memory_callers ORDER BY name`).all() as Row[]).map(toCaller);
  }

  /** The caller a token belongs to, noting the visit; undefined for a token nobody holds. */
  authenticate(token: string): Caller | undefined {
    if (!token) return undefined;
    const r = this.db.prepare(`SELECT * FROM memory_callers WHERE token_hash = ?`).get(hash(token)) as Row | undefined;
    if (!r) return undefined;
    this.db.prepare(`UPDATE memory_callers SET last_seen_at = ? WHERE id = ?`).run(this.now(), r.id);
    return toCaller(r);
  }

  update(id: number, grant: { readTags?: string[]; writeGlobal?: boolean }): Caller | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const tags = grant.readTags ? [...new Set(grant.readTags.map((t) => t.trim()).filter(Boolean))] : current.readTags;
    this.db.prepare(`UPDATE memory_callers SET read_tags = ?, write_global = ? WHERE id = ?`)
      .run(JSON.stringify(tags), (grant.writeGlobal ?? current.writeGlobal) ? 1 : 0, id);
    return this.get(id);
  }

  /** Take the caller away. Its scope's claims stay in history; nothing can read them through it again. */
  revoke(id: number): boolean {
    return this.db.prepare(`DELETE FROM memory_callers WHERE id = ?`).run(id).changes > 0;
  }
}

/** Whether a global claim with these tags is inside the caller's grant. */
export function mayRead(caller: Caller, tags: string[]): boolean {
  if (caller.readTags.includes("*")) return true;
  return tags.some((t) => caller.readTags.includes(t));
}
