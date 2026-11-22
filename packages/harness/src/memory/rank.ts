import type { Fact } from "./facts.js";

/**
 * How claims are ranked for a message: which ones match, and in what order.
 *
 * Matching counted every word alike, so a word most claims share ("job",
 * "test", "discord", "project") put a claim in front of the model as surely
 * as the word that named it: replayed over the owner's messages, a turn was
 * given four claims on average and few of them were about the message. A
 * word now counts by how rare it is among the claims in play (an IDF
 * weight), so a claim needs words that pick it out.
 *
 * The floor is held on the match alone. Freshness, trust and confidence
 * only order what already matched: an old claim that names the thing asked
 * about is still found, it just yields to a fresher one that matches as well.
 */

/** Days after which a claim nobody has restated counts half as fresh for ordering. */
export const FRESH_HALF_LIFE_DAYS = 90;
const DAY_MS = 86_400_000;

/** How far each source's word is taken when two claims match alike: the owner's own first. */
const TRUST_WEIGHT: Record<Fact["trust"], number> = { owner: 1, agent: 0.85, tool: 0.8, external: 0.7 };

/** A token's weight among `total` claims, `holding` of which contain it: 1 when one claim holds it, falling as more do. */
export function rarity(holding: number, total: number): number {
  if (holding <= 0 || total <= 1) return 1;
  return Math.min(1, Math.log(1 + total / holding) / Math.log(1 + total));
}

/**
 * What a value hit is worth on a value `length` long, against the mean: 1 at
 * or under the mean, less on a long one (BM25's length norm, b = 0.75, with
 * no boost for a short value: a one-line preference would match any message
 * sharing a word with it). A claim that runs to a page holds most words by length alone,
 * and a page-long note about cron jobs matched every message that said "job".
 */
export function lengthNorm(length: number, mean: number): number {
  if (mean <= 0) return 1;
  return Math.min(1, 1 / (0.25 + 0.75 * (length / mean)));
}

/**
 * How fresh a claim is, 0.5 to 1: by when it was last stated, not last
 * used. Use follows recall, so a claim recall kept offering would keep
 * itself fresh; a restatement is the owner or a reader saying it again.
 */
export function freshness(claim: Pick<Fact, "updatedAt">, now: number): number {
  const ageDays = Math.max(0, now - claim.updatedAt) / DAY_MS;
  return 0.5 + 0.5 * 2 ** (-ageDays / FRESH_HALF_LIFE_DAYS);
}

/** What a match is worth once it has matched: fresher, more trusted, surer first. */
export function standingWeight(claim: Pick<Fact, "updatedAt" | "trust" | "confidence">, now: number): number {
  const confidence = Number.isFinite(claim.confidence) ? Math.min(1, Math.max(0.1, claim.confidence)) : 1;
  return freshness(claim, now) * TRUST_WEIGHT[claim.trust] * confidence;
}

/** The narrower of two scopes in play wins: a project's or an agent's own claim over the global one under the same key. */
const specific = (scope: string): number => (scope === "global" ? 0 : 1);

/**
 * One claim per key. The same key in two scopes in play is one question
 * with two answers, and both went to the model (the same pinned claim
 * twice, once global and once an agent's). The owner's word answers over
 * anyone else's, whatever its scope; then the narrower scope; between
 * equals, the one stated last. Order is otherwise kept.
 */
export function onePerKey<T extends Pick<Fact, "key" | "scope" | "updatedAt" | "trust">>(claims: T[]): T[] {
  const owner = (c: T): number => (c.trust === "owner" ? 1 : 0);
  const better = (c: T, held: T): boolean =>
    owner(c) !== owner(held) ? owner(c) > owner(held) : specific(c.scope) !== specific(held.scope) ? specific(c.scope) > specific(held.scope) : c.updatedAt > held.updatedAt;
  const best = new Map<string, T>();
  for (const c of claims) {
    const held = best.get(c.key);
    if (!held || better(c, held)) best.set(c.key, c);
  }
  return claims.filter((c) => best.get(c.key) === c);
}

/**
 * As many claims as fit `chars` of keys and values, in order, never none
 * when there is one. Claims are a line each by rule, but older ones run to
 * a page, and ten of those were five thousand characters of every turn.
 */
export function withinChars<T extends Pick<Fact, "key" | "value">>(claims: T[], chars: number): T[] {
  const kept: T[] = [];
  let used = 0;
  for (const c of claims) {
    const size = c.key.length + c.value.length;
    if (kept.length > 0 && used + size > chars) break;
    kept.push(c);
    used += size;
  }
  return kept;
}
