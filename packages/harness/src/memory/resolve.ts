import { GLOBAL_SCOPE, type Fact, type FactsStore } from "./facts.js";
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

/** "project:pantry/city" into its parts. */
export function splitQualified(qualified: string): { scope: string; key: string } | undefined {
  const slash = qualified.lastIndexOf("/");
  if (slash <= 0) return undefined;
  return { scope: qualified.slice(0, slash), key: qualified.slice(slash + 1) };
}

export function applyResolution(
  facts: FactsStore,
  queue: ReviewQueue,
  ownerId: string,
  id: number,
  resolution: Resolution,
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
      if (facts.archive(ownerId, p.key, p.scope, "owner", `owner kept ${kept.qualified}`)) archived.push(p.qualified);
    }
  } else if (resolution.action === "promote") {
    for (const p of parts) {
      if (p.scope === GLOBAL_SCOPE) continue;
      const claim: Fact | undefined = facts.get(ownerId, p.key, p.scope);
      if (!claim) continue;
      const evidence = facts.trace(claim.id)?.evidence ?? [];
      facts.upsert(ownerId, { key: claim.key, value: claim.value, kind: claim.kind, scope: GLOBAL_SCOPE, trust: claim.trust, tags: claim.tags, evidence }, "owner");
      facts.archive(ownerId, p.key, p.scope, "owner", "promoted to global");
      promoted.push(p.qualified);
    }
  }
  // "both" and "dismiss" change no claim: the owner looked and said leave it.
  const words = resolution.action === "keep" ? `keep ${resolution.key}` : resolution.action;
  const resolved = queue.resolve(id, words)!;
  return { item: resolved, archived, promoted };
}
