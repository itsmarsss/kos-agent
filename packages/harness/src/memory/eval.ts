import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Inference } from "../agent/loop.js";
import { Kernel } from "../kernel/kernel.js";
import { SecretsRegistry } from "../secrets/secrets.js";
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
  /** Key and value may list alternatives: any one agreeing is a match. */
  expect: { key: string | string[]; value: string | string[]; scope?: string }[];
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

/** Two key words agree when equal or sharing their first four letters: reply and replies, employer and employment. */
function wordsAgree(a: string, b: string): boolean {
  return a === b || (a.length >= 4 && b.length >= 4 && a.slice(0, 4) === b.slice(0, 4));
}

const list = (v: string | string[]): string[] => (Array.isArray(v) ? v : [v]);

/** Key and value both have to agree: the key by any word in common, the value by containment. */
function matches(claim: Fact, want: GoldenCase["expect"][number]): boolean {
  const mine = claim.key.toLowerCase().split(/[_\s]+/).filter(Boolean);
  const keyOk = list(want.key).some((k) => k.toLowerCase().split(/[_\s]+/).filter(Boolean).some((t) => mine.some((m) => wordsAgree(m, t))));
  const valueOk = list(want.value).some((v) => claim.value.toLowerCase().includes(v.toLowerCase()));
  const scopeOk = !want.scope || claim.scope === want.scope;
  return keyOk && valueOk && scopeOk;
}

export type MemoryReader = "extractor" | "agent";

/**
 * One case through the fixed extractor: the floor.
 */
async function readWithExtractor(inference: Inference, c: GoldenCase, ws: Workspace, embedder: HashingEmbeddingProvider): Promise<{ facts: FactsStore; written: Fact[] }> {
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
  return { facts, written: report.claims };
}

/**
 * One case through KOS itself: a kernel in a scratch workspace, the memory
 * job fired by hand, its claims read back. The ceiling, and what the owner
 * actually runs.
 */
async function readWithAgent(inference: Inference, c: GoldenCase, root: string): Promise<{ facts: FactsStore; written: Fact[] }> {
  // No provider keys: the hashing embedder, so retrieval is held fixed.
  const kernel = await Kernel.boot({ rootDir: root, secrets: new SecretsRegistry(), inference, sessionless: true });
  try {
    for (const s of c.seed ?? []) kernel.facts.upsert("owner", { key: s.key, value: s.value, kind: s.kind, ...(s.scope ? { scope: s.scope } : {}) }, "seed");
    for (const e of c.events) {
      kernel.events.append({ userId: kernel.profile.ownerId, role: e.role, text: e.text, ...(e.project ? { projectSlug: e.project } : {}) });
    }
    const job = kernel.crons.list().find((j) => j.name === "kos.memory")!;
    kernel.crons.update(job.id, { name: job.name, schedule: job.schedule, type: "self_prompt", prompt: job.prompt!, task: job.task, enabled: true });
    kernel.startCron();
    const before = new Set(kernel.facts.all(kernel.profile.ownerId).map((f) => f.id));
    await kernel.fireCron(job.id);
    await kernel.queue.drain();
    const written = kernel.facts.all(kernel.profile.ownerId).filter((f) => !before.has(f.id));
    // Read back through a store on the same file so the caller can search it after close.
    return { facts: kernel.facts, written };
  } finally {
    kernel.stopCron();
  }
}

export async function runMemoryEval(
  inference: Inference,
  cases: GoldenCase[] = loadGolden(),
  options: { reader?: MemoryReader } = {},
): Promise<EvalReport> {
  const embedder = new HashingEmbeddingProvider(64);
  const reader = options.reader ?? "extractor";
  const results: CaseResult[] = [];
  for (const c of cases) {
    const root = mkdtempSync(join(tmpdir(), "kos-memeval-"));
    const ws = reader === "extractor" ? Workspace.open(root) : undefined;
    try {
      const { facts, written } = ws
        ? await readWithExtractor(inference, c, ws, embedder)
        : await readWithAgent(inference, c, root);
      const matchedWants = c.expect.filter((w) => written.some((cl) => matches(cl, w)));
      const unexpected = written.filter((cl) => !c.expect.some((w) => matches(cl, w))).map((cl) => `${cl.key}: ${cl.value}`);
      const forbidden = c.forbid.filter((word) => written.some((cl) => `${cl.key} ${cl.value}`.toLowerCase().includes(word.toLowerCase())));
      // Would a later turn get it back? Ask with the expected value's words, the way the owner would.
      let recalled = 0;
      for (const w of matchedWants) {
        const scopes = [GLOBAL_SCOPE, ...(w.scope ? [w.scope] : []), ...new Set(c.events.filter((e) => e.project).map((e) => projectScope(e.project!)))];
        const hits = facts.search("owner", `${list(w.key)[0]!.replace(/_/g, " ")} ${list(w.value)[0]!}`, 5, { scopes, minScore: 2 });
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
      ws?.close();
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
export function renderEvalReport(report: EvalReport, reader: MemoryReader = "extractor"): string {
  const lines = [
    `memory ${reader} eval: recall ${(report.recall * 100).toFixed(0)}%, precision ${(report.precision * 100).toFixed(0)}%, clean ${report.clean}/${report.total}`,
    "",
  ];
  for (const r of report.cases) {
    const flags = [...(r.forbidden.length ? [`FORBIDDEN ${r.forbidden.join(", ")}`] : []), ...(r.unexpected.length ? [`extra: ${r.unexpected.join("; ")}`] : [])];
    lines.push(`- ${r.name}: ${r.matched}/${r.expected} expected (${r.recalled} recalled)${flags.length ? ` | ${flags.join(" | ")}` : ""}`);
    for (const cl of r.claims) lines.push(`    ${cl.scope} ${cl.key} = ${cl.value} (${cl.trust})`);
  }
  return lines.join("\n");
}
