import type { Db } from "../store/db.js";
import type { CandidateFact, FactKind } from "./salience.js";

export type ClaimScope = string;

export interface Fact {
  id: number;
  userId: string;
  key: string;
  value: string;
  kind: FactKind;
  /** global, project:<slug>, or caller:<name>. */
  scope: ClaimScope;
  /** Who wrote it: a conversation id, "chat", "dashboard". */
  source: string | null;
  /** Free-form labels, for grouping and for scoped recall. */
  tags: string[];
  /**
   * Always in context, regardless of what the message matched. For the handful
   * of things every agent should know without having to search for them.
   */
  pinned: boolean;
  /** How far the claim can be trusted: owner said it, an agent inferred it, a tool produced it. */
  trust: "owner" | "agent" | "tool" | "external";
  confidence: number;
  createdAt: number;
  updatedAt: number;
  /** Set once a newer claim replaced this one. Current claims have null. */
  supersededAt: number | null;
  /** The claim this one replaced. */
  supersedes: number | null;
  lastUsedAt: number | null;
  useCount: number;
}

/**
 * Claims: what KOS believes, with where it came from and what came before.
 *
 * A fact used to be one row per key, overwritten on restatement. A claim is
 * a row that is never overwritten: a new value closes the old row and
 * writes a new one pointing at it, so "what did you believe last month"
 * has an answer. Each claim carries a scope (global, a project, an outside
 * caller), a trust level, and links to the events it was drawn from.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_claims (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global',
  source TEXT,
  tags TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  trust TEXT NOT NULL DEFAULT 'owner',
  confidence REAL NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  superseded_at INTEGER,
  supersedes INTEGER,
  last_used_at INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS memory_claims_current ON memory_claims (user_id, scope, key) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS memory_claims_key ON memory_claims (user_id, key);
CREATE TABLE IF NOT EXISTS memory_evidence (
  claim_id INTEGER NOT NULL,
  event_id INTEGER NOT NULL,
  PRIMARY KEY (claim_id, event_id)
);
CREATE TABLE IF NOT EXISTS memory_revisions (
  id INTEGER PRIMARY KEY,
  claim_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  actor TEXT,
  at INTEGER NOT NULL,
  detail TEXT
);
`;

interface Row {
  id: number;
  user_id: string;
  key: string;
  value: string;
  kind: string;
  scope: string;
  source: string | null;
  tags: string | null;
  pinned: number;
  trust: string;
  confidence: number;
  created_at: number;
  updated_at: number;
  superseded_at: number | null;
  supersedes: number | null;
  last_used_at: number | null;
  use_count: number;
}

export const GLOBAL_SCOPE = "global";
/** Key words too common to suggest two claims are about one thing. */
const GENERIC = new Set(["owner", "the", "and", "for", "with", "has", "is", "user", "my", "name", "info", "preference", "pref"]);
export const projectScope = (slug: string): string => `project:${slug}`;
export const callerScope = (name: string): string => `caller:${name}`;

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((t): t is string => typeof t === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Words carrying no retrieval signal. Kept deliberately short: this filters
 * question scaffolding ("what did I say my X was again"), not vocabulary.
 */
const STOPWORDS = new Set([
  "the", "and", "for", "you", "your", "yours", "was", "were", "are", "did",
  "does", "do", "done", "have", "has", "had", "with", "that", "this", "these",
  "those", "what", "when", "where", "which", "who", "whom", "why", "how",
  "can", "could", "would", "should", "will", "shall", "may", "might", "must",
  "about", "again", "just", "from", "into", "than", "then", "them", "they",
  "there", "here", "some", "any", "all", "not", "but", "our", "out", "get",
  "got", "tell", "told", "say", "said", "please", "thanks", "hey", "now",
]);

const MIN_TOKEN_LENGTH = 3;
const MAX_TOKENS = 12;

/**
 * Split a message into retrieval tokens: lowercase alphanumerics, stopwords
 * and very short words dropped, deduped, capped so one long message cannot
 * match everything.
 */
/**
 * A token reduced to what a related word shares with it.
 *
 * Matching is substring containment, so a query token that is shorter than
 * the stored word already matches: "budget" finds "budgets". The reverse did
 * not, and asking about "meetings" or "expenses" when the entry says
 * "meeting" or "expense" is the ordinary way to ask. Cutting a plural suffix
 * off the query makes the two meet in the middle.
 *
 * Deliberately not a stemmer. It handles the suffixes an owner's phrasing
 * actually varies by, and leaves anything shorter than five letters alone so
 * "gas" does not become "ga".
 */
export function stem(token: string): string {
  if (token.length < 5) return token;
  if (token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.endsWith("sses") || token.endsWith("shes") || token.endsWith("ches")) {
    return token.slice(0, -2);
  }
  if (token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

export function tokenize(text: string): string[] {
  const raw = text.toLowerCase().match(/[a-z0-9][a-z0-9'_-]*/g) ?? [];
  const seen = new Set<string>();
  for (const token of raw) {
    if (token.length < MIN_TOKEN_LENGTH) continue;
    if (STOPWORDS.has(token)) continue;
    seen.add(token);
    if (seen.size >= MAX_TOKENS) break;
  }
  return [...seen];
}

function toFact(row: Row): Fact {
  return {
    id: row.id,
    userId: row.user_id,
    key: row.key,
    value: row.value,
    kind: row.kind as FactKind,
    scope: row.scope,
    source: row.source,
    tags: parseTags(row.tags),
    pinned: row.pinned === 1,
    trust: row.trust as Fact["trust"],
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    supersededAt: row.superseded_at,
    supersedes: row.supersedes,
    lastUsedAt: row.last_used_at,
    useCount: row.use_count,
  };
}

export interface ClaimInput extends CandidateFact {
  tags?: string[];
  pinned?: boolean;
  scope?: ClaimScope;
  trust?: Fact["trust"];
  confidence?: number;
  /** Ids of the log events this claim was drawn from. */
  evidence?: number[];
}

export interface ClaimQuery {
  tags?: string[];
  /** Which scopes to read. Default: everything current. */
  scopes?: ClaimScope[];
  /** Lowest match score worth returning. Default 0: any token hit. */
  minScore?: number;
}

export interface Trace {
  claim: Fact;
  /** The log events it was drawn from. */
  evidence: number[];
  /** What it replaced, newest first. */
  before: Fact[];
  revisions: { action: string; actor: string | null; at: number; detail: string | null }[];
}

/** Structured claims: the cheap, exact tier of memory, consulted every turn. */
export class FactsStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    this.db.exec(SCHEMA);
    this.migrateFacts();
  }

  /** An older workspace's memory_facts become the first claims, once. The old table stays. */
  private migrateFacts(): void {
    const has = this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_facts'`).get();
    if (!has) return;
    const filled = (this.db.prepare(`SELECT count(*) AS n FROM memory_claims`).get() as { n: number }).n > 0;
    if (filled) return;
    const old = this.db.prepare(`SELECT * FROM memory_facts ORDER BY id`).all() as {
      user_id: string; key: string; value: string; kind: string; source: string | null; tags: string | null; pinned: number | null; created_at: number; updated_at: number;
    }[];
    const insert = this.db.prepare(
      `INSERT INTO memory_claims (user_id, key, value, kind, scope, source, tags, pinned, trust, confidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'global', ?, ?, ?, 'owner', 1, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const r of old) insert.run(r.user_id, r.key, r.value, r.kind, r.source, r.tags, r.pinned ? 1 : 0, r.created_at, r.updated_at);
    })();
  }

  private revise(claimId: number, action: string, actor: string | null, detail: string | null = null): void {
    this.db.prepare(`INSERT INTO memory_revisions (claim_id, action, actor, at, detail) VALUES (?, ?, ?, ?, ?)`)
      .run(claimId, action, actor, this.now(), detail);
  }

  private link(claimId: number, evidence: number[] | undefined): void {
    if (!evidence?.length) return;
    const stmt = this.db.prepare(`INSERT OR IGNORE INTO memory_evidence (claim_id, event_id) VALUES (?, ?)`);
    for (const e of evidence) stmt.run(claimId, e);
  }

  /**
   * Write a claim. A restatement with the same value touches the current
   * row and adds evidence; a new value supersedes it: the old row is
   * closed and a new one written pointing back, tags and pin carried
   * unless given. Nothing is overwritten.
   */
  upsert(userId: string, fact: ClaimInput, source: string | null = null): Fact {
    const ts = this.now();
    const scope = fact.scope ?? GLOBAL_SCOPE;
    const current = this.current(userId, fact.key, scope);
    const tags = fact.tags ? JSON.stringify(fact.tags) : (current?.tags.length ? JSON.stringify(current.tags) : null);
    const pinned = fact.pinned ?? current?.pinned ?? false;
    return this.db.transaction((): Fact => {
      if (current && current.value === fact.value) {
        this.db.prepare(
          `UPDATE memory_claims SET kind = ?, source = COALESCE(?, source), tags = ?, pinned = ?, updated_at = ?,
             trust = ?, confidence = ? WHERE id = ?`,
        ).run(fact.kind, source, tags, pinned ? 1 : 0, ts, fact.trust ?? current.trust, fact.confidence ?? current.confidence, current.id);
        this.link(current.id, fact.evidence);
        return this.byId(current.id)!;
      }
      if (current) {
        this.db.prepare(`UPDATE memory_claims SET superseded_at = ? WHERE id = ?`).run(ts, current.id);
      }
      const info = this.db.prepare(
        `INSERT INTO memory_claims (user_id, key, value, kind, scope, source, tags, pinned, trust, confidence, created_at, updated_at, supersedes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(userId, fact.key, fact.value, fact.kind, scope, source, tags, pinned ? 1 : 0, fact.trust ?? "owner", fact.confidence ?? 1, ts, ts, current?.id ?? null);
      const id = Number(info.lastInsertRowid);
      this.link(id, fact.evidence);
      this.revise(id, current ? "supersede" : "add", source, current ? `was: ${current.value}` : null);
      return this.byId(id)!;
    })();
  }

  private byId(id: number): Fact | undefined {
    const row = this.db.prepare(`SELECT * FROM memory_claims WHERE id = ?`).get(id) as Row | undefined;
    return row ? toFact(row) : undefined;
  }

  private current(userId: string, key: string, scope: ClaimScope): Fact | undefined {
    const row = this.db.prepare(
      `SELECT * FROM memory_claims WHERE user_id = ? AND key = ? AND scope = ? AND superseded_at IS NULL`,
    ).get(userId, key, scope) as Row | undefined;
    return row ? toFact(row) : undefined;
  }

  /** The current claim for a key: in the scope given, else global first, then any. */
  get(userId: string, key: string, scope?: ClaimScope): Fact | undefined {
    if (scope) return this.current(userId, key, scope);
    const row = this.db.prepare(
      `SELECT * FROM memory_claims WHERE user_id = ? AND key = ? AND superseded_at IS NULL
       ORDER BY CASE WHEN scope = 'global' THEN 0 ELSE 1 END, updated_at DESC LIMIT 1`,
    ).get(userId, key) as Row | undefined;
    return row ? toFact(row) : undefined;
  }

  /** Every current claim, newest first, in the scopes given or all of them. */
  all(userId: string, scopes?: ClaimScope[]): Fact[] {
    const rows = scopes?.length
      ? (this.db.prepare(
          `SELECT * FROM memory_claims WHERE user_id = ? AND superseded_at IS NULL AND scope IN (${scopes.map(() => "?").join(",")})
           ORDER BY updated_at DESC`,
        ).all(userId, ...scopes) as Row[])
      : (this.db.prepare(`SELECT * FROM memory_claims WHERE user_id = ? AND superseded_at IS NULL ORDER BY updated_at DESC`).all(userId) as Row[]);
    return rows.map(toFact);
  }

  /** Entries that go into every prompt without needing to be matched. */
  pinned(userId: string, scopes?: ClaimScope[]): Fact[] {
    return this.all(userId, scopes).filter((f) => f.pinned);
  }

  setPinned(userId: string, key: string, pinned: boolean, scope?: ClaimScope): Fact | undefined {
    const claim = this.get(userId, key, scope);
    if (!claim) return undefined;
    // The outside world's word does not go into every prompt unasked.
    if (pinned && claim.trust === "external") throw new Error(`${key} came from outside (${claim.source ?? "a caller"}); say it yourself to pin it`);
    this.db.prepare(`UPDATE memory_claims SET pinned = ?, updated_at = ? WHERE id = ?`).run(pinned ? 1 : 0, this.now(), claim.id);
    this.revise(claim.id, pinned ? "pin" : "unpin", null);
    return this.byId(claim.id);
  }

  /** Every distinct tag in use, for filters and for telling an agent what exists. */
  tags(userId: string): string[] {
    const seen = new Set<string>();
    for (const fact of this.all(userId)) for (const t of fact.tags) seen.add(t);
    return [...seen].sort();
  }

  /** Every claim ever made under a key, any scope, oldest first. */
  history(userId: string, key: string): Fact[] {
    return (this.db.prepare(`SELECT * FROM memory_claims WHERE user_id = ? AND key = ? ORDER BY created_at, id`).all(userId, key) as Row[]).map(toFact);
  }

  /** Where a claim came from and what it replaced. */
  trace(id: number): Trace | undefined {
    const claim = this.byId(id);
    if (!claim) return undefined;
    const evidence = (this.db.prepare(`SELECT event_id FROM memory_evidence WHERE claim_id = ? ORDER BY event_id`).all(id) as { event_id: number }[]).map((r) => r.event_id);
    const before: Fact[] = [];
    let prev = claim.supersedes;
    while (prev !== null && before.length < 50) {
      const p = this.byId(prev);
      if (!p) break;
      before.push(p);
      prev = p.supersedes;
    }
    const revisions = this.db.prepare(`SELECT action, actor, at, detail FROM memory_revisions WHERE claim_id = ? ORDER BY id`).all(id) as Trace["revisions"];
    return { claim, evidence, before, revisions };
  }

  /** Note that claims were put in front of the model, for decay later. */
  markUsed(ids: number[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(`UPDATE memory_claims SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?`);
    const ts = this.now();
    this.db.transaction(() => { for (const id of ids) stmt.run(ts, id); })();
  }

  /**
   * Keyword search over keys and values of current claims.
   *
   * The query is a whole user message, so it is tokenized rather than matched
   * as one substring. Claims are per-user and small, so scoring in code buys
   * better ranking than SQL can express here.
   */
  search(userId: string, query: string, limit = 20, options: ClaimQuery = {}): Fact[] {
    const tokens = tokenize(query);
    const wanted = options.tags?.filter(Boolean) ?? [];
    const all = wanted.length
      ? this.all(userId, options.scopes).filter((f) => f.tags.some((t) => wanted.includes(t)))
      : this.all(userId, options.scopes); // already ordered by updated_at DESC
    if (tokens.length === 0) return all.slice(0, limit);
    const needle = query.trim().toLowerCase();
    const floor = options.minScore ?? 0;
    const scored: { fact: Fact; score: number }[] = [];
    for (const fact of all) {
      const key = fact.key.toLowerCase();
      const value = fact.value.toLowerCase();
      let score = 0;
      for (const token of tokens) {
        // A hit on the key is a stronger signal than one buried in the value.
        if (key.includes(token)) score += 2;
        else if (value.includes(token)) score += 1;
        else {
          // The same word in a different number is still the same word, and
          // worth slightly less only because it is a looser match.
          const root = stem(token);
          if (root === token) continue;
          if (key.includes(root)) score += 1.5;
          else if (value.includes(root)) score += 0.5;
        }
      }
      // Whole-phrase containment stays the strongest signal when it happens.
      // A phrase is more than one word; one word already scored above.
      if (tokens.length > 1 && needle && (key.includes(needle) || value.includes(needle))) score += 5;
      if (score > 0 && score >= floor) scored.push({ fact, score });
    }
    scored.sort((a, b) => b.score - a.score || b.fact.updatedAt - a.fact.updatedAt);
    return scored.slice(0, limit).map((s) => s.fact);
  }

  /**
   * Put a claim away without forgetting it: closed like a superseded one,
   * with nothing after it. History keeps it; recall stops offering it.
   */
  archive(userId: string, key: string, scope: ClaimScope, actor: string | null, reason: string | null = null): Fact | undefined {
    const claim = this.current(userId, key, scope);
    if (!claim) return undefined;
    this.db.prepare(`UPDATE memory_claims SET superseded_at = ? WHERE id = ?`).run(this.now(), claim.id);
    this.revise(claim.id, "archive", actor, reason);
    return this.byId(claim.id);
  }

  /**
   * Two claims that are one thing: the one dropped is closed and points
   * at the one kept, its evidence moves across, and both are revised so
   * the merge can be read back and undone by hand if it was wrong.
   */
  merge(userId: string, keep: { key: string; scope: ClaimScope }, drop: { key: string; scope: ClaimScope }, actor: string | null): Fact | undefined {
    const kept = this.current(userId, keep.key, keep.scope);
    const dropped = this.current(userId, drop.key, drop.scope);
    if (!kept || !dropped || kept.id === dropped.id) return undefined;
    this.db.transaction(() => {
      this.db.prepare(`INSERT OR IGNORE INTO memory_evidence (claim_id, event_id) SELECT ?, event_id FROM memory_evidence WHERE claim_id = ?`).run(kept.id, dropped.id);
      this.db.prepare(`UPDATE memory_claims SET superseded_at = ? WHERE id = ?`).run(this.now(), dropped.id);
      this.revise(dropped.id, "merged_into", actor, `${keep.scope}/${keep.key}`);
      this.revise(kept.id, "merge", actor, `absorbed ${drop.scope}/${drop.key}: ${dropped.value}`);
    })();
    return this.byId(kept.id);
  }

  /** Current claims nobody has used in a while, never pinned ones. */
  stale(userId: string, olderThanMs: number): Fact[] {
    const cutoff = this.now() - olderThanMs;
    return this.all(userId).filter((f) => !f.pinned && (f.lastUsedAt ?? f.createdAt) < cutoff);
  }

  /**
   * Pairs that may be one thing or may disagree: the same key in two
   * scopes, or keys sharing a word whose values differ. Candidates for the
   * dream job to judge, not judgements.
   */
  pairs(userId: string): { a: Fact; b: Fact; why: "same_key" | "shared_word" }[] {
    const all = this.all(userId);
    const out: { a: Fact; b: Fact; why: "same_key" | "shared_word" }[] = [];
    const words = (f: Fact): Set<string> => new Set(f.key.split("_").filter((w) => w.length >= 3 && !GENERIC.has(w)));
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i]!;
        const b = all[j]!;
        if (a.key === b.key && a.scope !== b.scope) {
          out.push({ a, b, why: "same_key" });
          continue;
        }
        if (a.key === b.key) continue;
        const wa = words(a);
        if (wa.size === 0) continue;
        if ([...words(b)].some((w) => wa.has(w))) out.push({ a, b, why: "shared_word" });
      }
    }
    return out.slice(0, 200);
  }

  /**
   * Forget a key for good: every claim ever made under it, in the scope
   * given or all scopes, with its evidence links. Returns the event ids
   * the evidence pointed at, so the caller can redact the log too; a
   * forget the owner asked for must not be findable by meaning afterwards.
   */
  delete(userId: string, key: string, scope?: ClaimScope): { removed: boolean; evidence: number[] } {
    const rows = (scope
      ? this.db.prepare(`SELECT id FROM memory_claims WHERE user_id = ? AND key = ? AND scope = ?`).all(userId, key, scope)
      : this.db.prepare(`SELECT id FROM memory_claims WHERE user_id = ? AND key = ?`).all(userId, key)) as { id: number }[];
    if (rows.length === 0) return { removed: false, evidence: [] };
    const ids = rows.map((r) => r.id);
    const marks = ids.map(() => "?").join(",");
    const evidence = (this.db.prepare(`SELECT DISTINCT event_id FROM memory_evidence WHERE claim_id IN (${marks})`).all(...ids) as { event_id: number }[]).map((r) => r.event_id);
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM memory_evidence WHERE claim_id IN (${marks})`).run(...ids);
      this.db.prepare(`DELETE FROM memory_revisions WHERE claim_id IN (${marks})`).run(...ids);
      this.db.prepare(`DELETE FROM memory_claims WHERE id IN (${marks})`).run(...ids);
    })();
    return { removed: true, evidence };
  }
}
