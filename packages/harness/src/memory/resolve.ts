import { GLOBAL_SCOPE, type ClaimScope, type Fact, type FactsStore } from "./facts.js";
import type { ReviewItem, ReviewQueue } from "./review.js";

/**
 * The owner's answer to a flagged item, carried out.
 *
 * A decision that only got written down was a decision the next dream
 * had to notice and act on, which it might not. Now the answer does the
 * work: keeping one side of a contradiction archives the other, promoting
 * a project claim writes it global and closes the project one, and both
 * are on the record as the owner's doing.
 */

export type ReviewAction = "keep" | "both" | "promote" | "dismiss";

export interface Resolution {
  action: ReviewAction;
  /** For keep: the scope-qualified key to keep, as the item lists them. */
  key?: string;
}

export interface ResolutionReport {
  item: ReviewItem;
  archived: string[];
  promoted: string[];
}

/**
 * Who settled it, for the record on the item and on every claim it moved:
 * the owner, or KOS when the dream job was sure enough to act on its lean.
 */
export interface Decider {
  by: string;
  /** What the claims' history names as the source of the change. */
  source: string;
  /** How sure KOS was, 0 to 1, when it was KOS. */
  sure?: number;
}

const OWNER: Decider = { by: "owner", source: "owner" };

/**
 * What the dream job said it would do, as a resolution the buttons could
 * also give: "keep <one of the item's keys>", "both", "promote" or
 * "dismiss". Anything else, or a key the item is not about, is no lean.
 */
export function parseLean(lean: string, keys: string[]): Resolution | undefined {
  const text = lean.trim();
  const plain = text.toLowerCase();
  if (plain === "both" || plain === "promote" || plain === "dismiss") return { action: plain };
  const keep = /^keep\s+(\S+)$/i.exec(text);
  if (keep && keys.includes(keep[1]!)) return { action: "keep", key: keep[1]! };
  return undefined;
}

/** "project:pantry/city" into its parts. */
export function splitQualified(qualified: string): { scope: string; key: string } | undefined {
  const slash = qualified.lastIndexOf("/");
  if (slash <= 0) return undefined;
  return { scope: qualified.slice(0, slash), key: qualified.slice(slash + 1) };
}

/**
 * One claim an item is about, as the owner needs to see it to decide: what
 * it says, not just what it is called, and how much it is leaned on.
 */
export interface ReviewClaim {
  /** As the item lists it: global/city. */
  qualified: string;
  scope: string;
  key: string;
  /** Absent when the claim is gone already: archived by a later dream, say. */
  value?: string;
  kind?: string;
  trust?: string;
  useCount?: number;
  lastUsedAt?: number | null;
  createdAt?: number;
}

/** The item with its claims looked up, for a surface that shows them. */
export function describeReview(facts: FactsStore, ownerId: string, item: ReviewItem): ReviewItem & { claims: ReviewClaim[] } {
  const claims = item.keys.map((qualified): ReviewClaim => {
    const parts = splitQualified(qualified);
    if (!parts) return { qualified, scope: "", key: qualified };
    const claim = facts.get(ownerId, parts.key, parts.scope as ClaimScope);
    return claim
      ? {
          qualified,
          ...parts,
          value: claim.value,
          kind: claim.kind,
          trust: claim.trust,
          useCount: claim.useCount,
          lastUsedAt: claim.lastUsedAt,
          createdAt: claim.createdAt,
        }
      : { qualified, ...parts };
  });
  return { ...item, claims };
}

export function applyResolution(
  facts: FactsStore,
  queue: ReviewQueue,
  ownerId: string,
  id: number,
  resolution: Resolution,
  decider: Decider = OWNER,
): ResolutionReport | undefined {
  const item = queue.get(id);
  if (!item || item.resolvedAt !== null) return undefined;
  const archived: string[] = [];
  const promoted: string[] = [];
  const parts = item.keys.map((k) => ({ qualified: k, ...splitQualified(k) })).filter((p): p is { qualified: string; scope: string; key: string } => p.scope !== undefined);

  if (resolution.action === "keep") {
    const kept = parts.find((p) => p.qualified === resolution.key);
    if (!kept) throw new Error(`keep needs one of: ${item.keys.join(", ")}`);
    for (const p of parts) {
      if (p.qualified === kept.qualified) continue;
      if (facts.archive(ownerId, p.key, p.scope, decider.source, `${decider.by} kept ${kept.qualified}`)) archived.push(p.qualified);
    }
  } else if (resolution.action === "promote") {
    for (const p of parts) {
      if (p.scope === GLOBAL_SCOPE) continue;
      const claim: Fact | undefined = facts.get(ownerId, p.key, p.scope);
      if (!claim) continue;
      // What a caller said about a project is not the owner's word about themselves.
      if (claim.trust === "external") continue;
      const evidence = facts.trace(claim.id)?.evidence ?? [];
      facts.upsert(ownerId, { key: claim.key, value: claim.value, kind: claim.kind, scope: GLOBAL_SCOPE, trust: claim.trust, tags: claim.tags, evidence }, decider.source);
      facts.archive(ownerId, p.key, p.scope, decider.source, `promoted to global by ${decider.by}`);
      promoted.push(p.qualified);
    }
  }
  // "both" and "dismiss" change no claim: whoever looked said leave it.
  const words = resolution.action === "keep" ? `keep ${resolution.key}` : resolution.action;
  const sure = decider.sure === undefined ? "" : `, ${Math.round(decider.sure * 100)}% sure`;
  const resolved = queue.resolve(id, decider.by === OWNER.by ? words : `${words} (${decider.by}${sure})`)!;
  return { item: resolved, archived, promoted };
}
