import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Inference } from "../agent/loop.js";
import { Workspace } from "../store/workspace.js";
import { HashingEmbeddingProvider } from "./embeddings.js";
import { EventLog } from "./events.js";
import { MemoryExtractor } from "./extractor.js";
import { FactsStore, GLOBAL_SCOPE, projectScope, type Fact } from "./facts.js";

/**
 * A small, fixed eval for the extractor: synthetic conversations with what
 * a good reader should keep and what it must not. Run against a real
 * model to get numbers; run against a fake in tests to pin the scoring.
 *
 * The embedder is held fixed (hashing) so a change in a score is a change
 * in extraction, not in retrieval. The numbers are a floor to notice a
 * regression by, not a leaderboard.
 */

export interface GoldenCase {
  name: string;
  seed?: { key: string; value: string; kind: "fact" | "preference"; scope?: string }[];
  events: { role: "owner" | "agent"; text: string; project?: string }[];
  expect: { key: string; value: string; scope?: string }[];
  forbid: string[];
}

export interface CaseResult {
  name: string;
  claims: { key: string; value: string; scope: string; trust: string }[];
  matched: number;
  expected: number;
  unexpected: string[];
  forbidden: string[];
  /** Expected claims that a turn asking about them would get back. */
  recalled: number;
}

export interface EvalReport {
  cases: CaseResult[];
  /** Expected claims found, over expected claims. */
  recall: number;
  /** Claims matching an expectation, over claims written. Cases expecting nothing count a clean run as 1. */
  precision: number;
  /** Cases where nothing forbidden was written. */
  clean: number;
  total: number;
}

export function loadGolden(path = new URL("../../eval/memory-golden.json", import.meta.url).pathname): GoldenCase[] {
  return (JSON.parse(readFileSync(path, "utf8")) as { cases: GoldenCase[] }).cases;
}

/** Key and value both have to agree: the key loosely (a substring either way), the value by containment. */
function matches(claim: Fact, want: GoldenCase["expect"][number]): boolean {
  const k = claim.key.toLowerCase();
  const w = want.key.toLowerCase();
  const keyOk = k.includes(w) || w.includes(k);
  const valueOk = claim.value.toLowerCase().includes(want.value.toLowerCase());
  const scopeOk = !want.scope || claim.scope === want.scope;
  return keyOk && valueOk && scopeOk;
}

export async function runMemoryEval(inference: Inference, cases: GoldenCase[] = loadGolden()): Promise<EvalReport> {
  const embedder = new HashingEmbeddingProvider(64);
  const results: CaseResult[] = [];
  for (const c of cases) {
    const root = mkdtempSync(join(tmpdir(), "kos-memeval-"));
    const ws = Workspace.open(root);
    try {
      const events = new EventLog(ws.db, embedder.dimension, Date.now, embedder.name);
      const facts = new FactsStore(ws.db);
      for (const s of c.seed ?? []) facts.upsert("owner", { key: s.key, value: s.value, kind: s.kind, ...(s.scope ? { scope: s.scope } : {}) }, "seed");
      const settings = new Map<string, unknown>();
      const extractor = new MemoryExtractor({
        ownerId: "owner",
        events,
        facts,
        inference,
        settings: { get: <T,>(k: string) => settings.get(k) as T | undefined, set: (k, v) => settings.set(k, v) },
      });
      for (const e of c.events) {
        const [vec] = await embedder.embed([e.text]);
        events.append({ userId: "owner", role: e.role, text: e.text, ...(e.project ? { projectSlug: e.project } : {}) }, vec);
      }
      const report = await extractor.run();
      const written = report.claims;
      const matchedWants = c.expect.filter((w) => written.some((cl) => matches(cl, w)));
      const unexpected = written.filter((cl) => !c.expect.some((w) => matches(cl, w))).map((cl) => `${cl.key}: ${cl.value}`);
      const forbidden = c.forbid.filter((word) => written.some((cl) => `${cl.key} ${cl.value}`.toLowerCase().includes(word.toLowerCase())));
      // Would a later turn get it back? Ask with the expected value's words, the way the owner would.
      let recalled = 0;
      for (const w of matchedWants) {
        const scopes = [GLOBAL_SCOPE, ...(w.scope ? [w.scope] : []), ...new Set(c.events.filter((e) => e.project).map((e) => projectScope(e.project!)))];
        const hits = facts.search("owner", `${w.key.replace(/_/g, " ")} ${w.value}`, 5, { scopes, minScore: 2 });
        if (hits.some((h) => matches(h, w))) recalled++;
      }
      results.push({
        name: c.name,
        claims: written.map((cl) => ({ key: cl.key, value: cl.value, scope: cl.scope, trust: cl.trust })),
        matched: matchedWants.length,
        expected: c.expect.length,
        unexpected,
        forbidden,
        recalled,
      });
    } finally {
      ws.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
  const expected = results.reduce((n, r) => n + r.expected, 0);
  const matched = results.reduce((n, r) => n + r.matched, 0);
  const writtenTotal = results.reduce((n, r) => n + r.claims.length, 0);
  const precision = writtenTotal === 0 ? 1 : matched / writtenTotal;
  return {
    cases: results,
    recall: expected === 0 ? 1 : matched / expected,
    precision,
    clean: results.filter((r) => r.forbidden.length === 0).length,
    total: results.length,
  };
}

/** A terminal-friendly account of a report. */
export function renderEvalReport(report: EvalReport): string {
  const lines = [
    `memory extractor eval: recall ${(report.recall * 100).toFixed(0)}%, precision ${(report.precision * 100).toFixed(0)}%, clean ${report.clean}/${report.total}`,
    "",
  ];
  for (const r of report.cases) {
    const flags = [...(r.forbidden.length ? [`FORBIDDEN ${r.forbidden.join(", ")}`] : []), ...(r.unexpected.length ? [`extra: ${r.unexpected.join("; ")}`] : [])];
    lines.push(`- ${r.name}: ${r.matched}/${r.expected} expected (${r.recalled} recalled)${flags.length ? ` | ${flags.join(" | ")}` : ""}`);
    for (const cl of r.claims) lines.push(`    ${cl.scope} ${cl.key} = ${cl.value} (${cl.trust})`);
  }
  return lines.join("\n");
}
