import { readFileSync } from "node:fs";

import Database from "better-sqlite3";

import { FactsStore, GLOBAL_SCOPE, projectScope, type Fact } from "./facts.js";
import { MATCHED_LIMIT, MemoryRetriever, STANDING_LIMIT, withStanding } from "./retriever.js";

/**
 * The recall eval: what a turn is given to remember, scored on a fixed set.
 *
 * The memory eval scores what a reader keeps; this scores what a turn is
 * then shown of it. Each case is a store of synthetic claims (a made-up
 * person, shaped like what a real workspace accumulates: one-line
 * preferences, page-long operational notes, pins from other projects) and a
 * message, with the claims a good recall puts in front of the model and the
 * ones it must not. No model is asked: the path is the kernel's own, the
 * standing claims and the matched ones within their budgets, so a score
 * moves only when ranking does.
 */

export interface RecallSeed {
  key: string;
  value: string;
  kind: "fact" | "preference";
  scope?: string;
  trust?: Fact["trust"];
  pinned?: boolean;
  /** Days since it was last stated. */
  ageDays?: number;
}

export interface RecallCase {
  name: string;
  /** Claims in the store; `seed` cases share the set's own, these are added to it. */
  claims?: RecallSeed[];
  message: string;
  /** The project the chat is in. */
  project?: string;
  /** Keys a turn must be given. */
  want: string[];
  /** Keys a turn must not be given. */
  avoid: string[];
}

export interface RecallSet {
  /** Claims every case starts with. */
  store: RecallSeed[];
  cases: RecallCase[];
}

export interface RecallCaseResult {
  name: string;
  given: string[];
  found: string[];
  missed: string[];
  unwanted: string[];
  /** Keys given more than once: the same question answered twice. */
  repeated: string[];
  /** Matched claims given (standing ones aside), and how many of those were wanted. */
  matched: number;
  matchedWanted: number;
}

export interface RecallEvalReport {
  cases: RecallCaseResult[];
  /** Wanted claims given, over wanted claims. */
  recall: number;
  /** Matched claims that were wanted, over matched claims given. */
  precision: number;
  /** Cases where nothing to avoid was given and no key twice. */
  clean: number;
  total: number;
  /** Mean claims given per turn, standing included. */
  meanGiven: number;
}

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 10, 1);
const OWNER = "owner";

export function loadRecallGolden(path = new URL("../../eval/memory-recall-golden.json", import.meta.url).pathname): RecallSet {
  return JSON.parse(readFileSync(path, "utf8")) as RecallSet;
}

async function runCase(store: RecallSeed[], c: RecallCase): Promise<RecallCaseResult> {
  const db = new Database(":memory:");
  let clock = NOW;
  const facts = new FactsStore(db, () => clock);
  try {
    for (const seed of [...store, ...(c.claims ?? [])]) {
      clock = NOW - (seed.ageDays ?? 0) * DAY_MS;
      facts.upsert(OWNER, {
        key: seed.key,
        value: seed.value,
        kind: seed.kind,
        scope: seed.scope ?? GLOBAL_SCOPE,
        trust: seed.trust ?? "owner",
        ...(seed.pinned ? { pinned: true } : {}),
      }, "seed");
    }
    clock = NOW;
    // As a turn reads it: the kernel's floor and limits, the chat's scopes.
    const recall = await new MemoryRetriever(facts).recall(OWNER, c.message, {
      factLimit: MATCHED_LIMIT,
      projectSlug: c.project ?? null,
      minScore: 2,
    });
    const standing = facts.standing(OWNER, [GLOBAL_SCOPE, ...(c.project ? [projectScope(c.project)] : [])], STANDING_LIMIT);
    const givenFacts = withStanding(standing, recall.facts);
    const given = givenFacts.map((f) => f.key);
    const standingKeys = new Set(standing.slice(0, STANDING_LIMIT).map((f) => f.key));
    const matched = given.filter((k) => !standingKeys.has(k));
    return {
      name: c.name,
      given,
      found: c.want.filter((k) => given.includes(k)),
      missed: c.want.filter((k) => !given.includes(k)),
      unwanted: c.avoid.filter((k) => given.includes(k)),
      repeated: [...new Set(given.filter((k, i) => given.indexOf(k) !== i))],
      matched: matched.length,
      matchedWanted: matched.filter((k) => c.want.includes(k)).length,
    };
  } finally {
    db.close();
  }
}

export async function runRecallEval(set: RecallSet = loadRecallGolden()): Promise<RecallEvalReport> {
  const cases: RecallCaseResult[] = [];
  for (const c of set.cases) cases.push(await runCase(set.store, c));
  const wanted = set.cases.reduce((n, c) => n + c.want.length, 0);
  const found = cases.reduce((n, r) => n + r.found.length, 0);
  const matched = cases.reduce((n, r) => n + r.matched, 0);
  const matchedWanted = cases.reduce((n, r) => n + r.matchedWanted, 0);
  return {
    cases,
    recall: wanted === 0 ? 1 : found / wanted,
    precision: matched === 0 ? 1 : matchedWanted / matched,
    clean: cases.filter((r) => r.unwanted.length === 0 && r.repeated.length === 0).length,
    total: cases.length,
    meanGiven: cases.reduce((n, r) => n + r.given.length, 0) / Math.max(1, cases.length),
  };
}

export function renderRecallReport(report: RecallEvalReport): string {
  const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;
  const lines = [
    `memory recall eval: recall ${pct(report.recall)}, precision ${pct(report.precision)}, clean ${report.clean}/${report.total}, ${report.meanGiven.toFixed(1)} claims a turn`,
    "",
  ];
  for (const r of report.cases) {
    const flags = [...(r.missed.length ? [`missed ${r.missed.join(", ")}`] : []), ...(r.unwanted.length ? [`UNWANTED ${r.unwanted.join(", ")}`] : []), ...(r.repeated.length ? [`TWICE ${r.repeated.join(", ")}`] : [])];
    lines.push(`- ${r.name}: ${r.found.length}/${r.found.length + r.missed.length} wanted, ${r.matched} matched${flags.length ? ` | ${flags.join(" | ")}` : ""}`);
  }
  return lines.join("\n");
}
