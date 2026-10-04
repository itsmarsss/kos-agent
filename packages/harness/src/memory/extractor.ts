import type { Inference } from "../agent/loop.js";
import { textOf } from "../models/types.js";
import type { EventLog, MemoryEvent } from "./events.js";
import { GLOBAL_SCOPE, projectScope, type Fact, type FactsStore } from "./facts.js";
import type { FactKind } from "./salience.js";

/**
 * The extractor: a cheap model reads what was said and proposes claims.
 *
 * The heuristics catch "my X is". Everything else that is worth keeping,
 * a decision, a preference stated sideways, a correction of something
 * remembered, needs a reader. This is it: in the background, a batch of
 * new events at a time, with the claims that might be related alongside
 * so it can say "supersede" rather than "add" a near-duplicate.
 *
 * It is not trusted. A proposal must cite the events it came from, the
 * cited events must be in the batch it was shown, and its scope and trust
 * are computed from those events, not taken from the model. What it did
 * is in the revisions and the run log, and the owner's forget still wins.
 */

export const EXTRACTOR_KEY = "memory.extractor";
export const BATCH_CHARS = 6000;
const MIN_CONFIDENCE = 0.5;
const MAX_OPS = 12;
const MAX_VALUE = 300;

export interface ExtractorState {
  /** The last event id the extractor has read. */
  lastEventId: number;
}

export interface ExtractorDeps {
  ownerId: string;
  events: EventLog;
  facts: FactsStore;
  inference: Inference;
  settings: { get: <T>(key: string) => T | undefined; set: (key: string, value: unknown) => unknown };
  batchChars?: number;
}

export interface ExtractionReport {
  batches: number;
  events: number;
  proposed: number;
  added: number;
  superseded: number;
  rejected: number;
  claims: Fact[];
}

export interface Proposal {
  op: "add" | "supersede" | "noop";
  key: string;
  value: string;
  kind: FactKind;
  scope: "global" | "project";
  evidence: number[];
  confidence: number;
}

const SYSTEM = [
  "You maintain an assistant's long-term memory about its owner. You are shown new conversation",
  "events, each with an id, and the claims already remembered that might relate. Propose what",
  "to remember so it stays useful months from now.",
  "",
  "Keep: identities, relationships, preferences, decisions, constraints, recurring arrangements,",
  "tools and services used, facts about the owner's projects. Drop: questions, one-off requests,",
  "small talk, transient state, anything the assistant guessed rather than the owner said.",
  "",
  "Each proposal must cite the event ids it is drawn from, and only ids you were shown. When the",
  'new information is about something a shown claim already covers, use "supersede" with that',
  "claim's exact key, even if you would have named it differently: one thing, one key, so a",
  'change replaces rather than duplicates. Use "add" only for something no shown claim covers,',
  'with a short generic snake_case key (city, employer, timezone, sister, coffee_order). Use "noop"',
  'to say a shown claim is still right. Scope is "project" when the thing is about the project',
  'the events belong to, "global" when it is about the owner anywhere.',
  "",
  'Reply with JSON only: {"ops":[{"op":"add"|"supersede"|"noop","key":"snake_case","value":"self-contained",',
  '"kind":"fact"|"preference","scope":"global"|"project","evidence":[ids],"confidence":0-1}]}',
  'Return {"ops":[]} when nothing is worth keeping. Prefer nothing over a guess. Never store',
  "secrets, passwords, card numbers or API keys, and never restate a claim already shown unchanged.",
].join("\n");

function normalizeKey(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const key = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
  return key || undefined;
}

/** What the model said, read strictly. Anything malformed is simply not a proposal. */
export function parseProposals(text: string): Proposal[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  const ops = (parsed as { ops?: unknown }).ops;
  if (!Array.isArray(ops)) return [];
  const out: Proposal[] = [];
  for (const entry of ops) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const op = e["op"] === "supersede" ? "supersede" : e["op"] === "noop" ? "noop" : e["op"] === "add" ? "add" : undefined;
    const key = normalizeKey(e["key"]);
    if (!op || !key) continue;
    const value = typeof e["value"] === "string" ? e["value"].trim().slice(0, MAX_VALUE) : "";
    const evidence = Array.isArray(e["evidence"]) ? e["evidence"].filter((x): x is number => typeof x === "number" && Number.isInteger(x)) : [];
    const confidence = typeof e["confidence"] === "number" && Number.isFinite(e["confidence"]) ? Math.min(1, Math.max(0, e["confidence"])) : 0.7;
    out.push({
      op,
      key,
      value,
      kind: e["kind"] === "preference" ? "preference" : "fact",
      scope: e["scope"] === "project" ? "project" : "global",
      evidence,
      confidence,
    });
    if (out.length >= MAX_OPS) break;
  }
  return out;
}

/** A shown claim whose key is the proposal's key with words taken away, if there is one. */
export function sameThing(proposed: string, shown: Fact[]): string | undefined {
  const mine = new Set(proposed.split("_").filter(Boolean));
  for (const f of shown) {
    const theirs = f.key.split("_").filter(Boolean);
    if (theirs.length && theirs.every((t) => mine.has(t))) return f.key;
  }
  return undefined;
}

/**
 * The claims a batch might be talking about: current, in its scopes,
 * sharing any word with it. Shown to the reader so it supersedes instead
 * of inventing a second key; a loose match costs a few tokens, a missed
 * one costs a duplicate, so the floor here is lower than for a turn.
 */
export function relatedClaims(facts: FactsStore, ownerId: string, batch: MemoryEvent[]): Fact[] {
  const projects = [...new Set(batch.map((e) => e.projectSlug).filter((p): p is string => p !== null))];
  const scopes = [GLOBAL_SCOPE, ...projects.map(projectScope)];
  const text = batch.map((e) => e.text).join("\n");
  return facts.search(ownerId, text, 40, { scopes, minScore: 1 });
}

/** A batch of unread events, as many as fit the budget, never none when there is one. */
export function takeBatch(fresh: MemoryEvent[], batchChars: number): MemoryEvent[] {
  const batch: MemoryEvent[] = [];
  let chars = 0;
  for (const e of fresh) {
    if (batch.length > 0 && chars + e.text.length > batchChars) break;
    batch.push(e);
    chars += e.text.length;
  }
  return batch;
}

/**
 * What a claim drawn from these events may be trusted as: the owner's own
 * word only when every cited event is the owner's; the outside world's if
 * any came through a caller; the agent's otherwise.
 */
export function trustOf(cited: MemoryEvent[]): "owner" | "agent" | "external" {
  if (cited.some((e) => e.trust === "external")) return "external";
  return cited.length > 0 && cited.every((e) => e.role === "owner") ? "owner" : "agent";
}

function describe(e: MemoryEvent): string {
  const when = new Date(e.ts).toISOString().slice(0, 10);
  const where = e.projectSlug ? `, project ${e.projectSlug}` : "";
  const via = e.trust === "external" ? `, via ${e.caller}` : "";
  return `[#${e.id}] (${e.role}${where}${via}, ${when}): ${e.text.slice(0, 1500)}`;
}

export class MemoryExtractor {
  private running = false;

  constructor(private readonly deps: ExtractorDeps) {}

  state(): ExtractorState {
    const raw = this.deps.settings.get<Partial<ExtractorState>>(EXTRACTOR_KEY);
    return { lastEventId: typeof raw?.lastEventId === "number" ? raw.lastEventId : 0 };
  }

  /** What has been said since the extractor last read: how many events, how much text. */
  pending(): { count: number; chars: number } {
    const events = this.deps.events.since(this.deps.ownerId, this.state().lastEventId, 2000);
    return { count: events.length, chars: events.reduce((n, e) => n + e.text.length, 0) };
  }

  get busy(): boolean {
    return this.running;
  }

  /** Read what is new, a batch at a time, and apply what survives the checks. */
  async run(options: { maxBatches?: number } = {}): Promise<ExtractionReport> {
    if (this.running) throw new Error("the extractor is already running");
    this.running = true;
    const report: ExtractionReport = { batches: 0, events: 0, proposed: 0, added: 0, superseded: 0, rejected: 0, claims: [] };
    try {
      const batchChars = this.deps.batchChars ?? BATCH_CHARS;
      const maxBatches = options.maxBatches ?? 20;
      while (report.batches < maxBatches) {
        const batch = this.nextBatch(batchChars);
        if (batch.length === 0) break;
        await this.extract(batch, report);
        report.batches++;
        report.events += batch.length;
        this.deps.settings.set(EXTRACTOR_KEY, { lastEventId: batch[batch.length - 1]!.id } satisfies ExtractorState);
      }
      return report;
    } finally {
      this.running = false;
    }
  }

  private nextBatch(batchChars: number): MemoryEvent[] {
    return takeBatch(this.deps.events.since(this.deps.ownerId, this.state().lastEventId, 200), batchChars);
  }

  private related(batch: MemoryEvent[]): Fact[] {
    return relatedClaims(this.deps.facts, this.deps.ownerId, batch);
  }

  private async extract(batch: MemoryEvent[], report: ExtractionReport): Promise<void> {
    const related = this.related(batch);
    const shown = related.length
      ? ["Claims already remembered that may relate:", ...related.map((f) => `- ${f.key} (${f.scope}, ${f.kind}): ${f.value}`), ""]
      : [];
    const response = await this.deps.inference.generate("cheap", {
      system: SYSTEM,
      messages: [{ role: "user", content: [{ type: "text", text: [...shown, "New events:", ...batch.map(describe)].join("\n") }] }],
      maxTokens: 1200,
    });
    const proposals = parseProposals(textOf(response.content));
    report.proposed += proposals.length;
    const ids = new Map(batch.map((e) => [e.id, e]));
    const relatedKeys = new Map(related.map((f) => [`${f.scope}:${f.key}`, f]));
    for (const p of proposals) {
      if (p.op === "noop") continue;
      // Evidence is the whole contract: cited, from this batch, and enough of it.
      const cited = p.evidence.map((id) => ids.get(id)).filter((e): e is MemoryEvent => e !== undefined);
      if (cited.length === 0 || cited.length !== p.evidence.length || !p.value || p.confidence < MIN_CONFIDENCE) {
        report.rejected++;
        continue;
      }
      // Scope and trust come from the evidence, not the model's say-so.
      const project = cited[0]!.projectSlug;
      const scope = p.scope === "project" && project && cited.every((e) => e.projectSlug === project) ? projectScope(project) : GLOBAL_SCOPE;
      const trust = trustOf(cited);
      // A new key that merely elaborates a shown one (home_city for city) is
      // the same claim: write it under the key the owner already has.
      const key = relatedKeys.has(`${scope}:${p.key}`) ? p.key : (sameThing(p.key, related.filter((f) => f.scope === scope)) ?? p.key);
      const before = relatedKeys.get(`${scope}:${key}`) ?? this.deps.facts.get(this.deps.ownerId, key, scope);
      if (before && before.value === p.value) continue;
      const written = this.deps.facts.upsert(
        this.deps.ownerId,
        { key, value: p.value, kind: p.kind, scope, trust, confidence: p.confidence, evidence: cited.map((e) => e.id) },
        "extractor",
      );
      if (written.supersedes) report.superseded++;
      else report.added++;
      report.claims.push(written);
    }
  }
}
