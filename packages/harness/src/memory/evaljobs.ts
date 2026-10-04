import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Inference } from "../agent/loop.js";
import { Kernel } from "../kernel/kernel.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { CLAIM_LINE, readPage } from "./pages.js";
import { splitQualified } from "./resolve.js";

/**
 * Evals for the two tidying jobs, the way the memory job has one: a fixed
 * set of synthetic states, the job itself fired in a scratch kernel, and
 * what it did compared with what a careful tidy would do. Numbers are a
 * floor to notice a regression by, not a grade; model output varies.
 */

export interface DreamCase {
  name: string;
  seed: { key: string; value: string; kind: "fact" | "preference"; daysSinceUse?: number }[];
  expect: {
    /** Pairs of scope-qualified keys: the first kept, the second folded in. */
    merged?: [string, string][];
    archived?: string[];
    /** Kinds that must be waiting for the owner. */
    flagged?: ("contradiction" | "promotion")[];
    /** Claims that must still be current afterwards. */
    kept?: string[];
    /** Pages that must exist, with at least one claim line. */
    pages?: string[];
  };
}

export interface ObserveCase {
  name: string;
  turns: [string, string][];
  mustMention: string[];
  mustNotMention: string[];
}

export interface JobCaseResult {
  name: string;
  met: string[];
  missed: string[];
  /** Things that should not have happened: a kept claim gone, a forbidden word in a note. */
  harm: string[];
  said: string;
}

export interface JobEvalReport {
  job: "dream" | "observe";
  cases: JobCaseResult[];
  /** Expectations met over expectations. */
  score: number;
  /** Cases with no harm. */
  clean: number;
  total: number;
}

const here = (file: string): string => new URL(`../../eval/${file}`, import.meta.url).pathname;

export function loadDreamGolden(path = here("memory-dream-golden.json")): DreamCase[] {
  return (JSON.parse(readFileSync(path, "utf8")) as { cases: DreamCase[] }).cases;
}

export function loadObserveGolden(path = here("memory-observe-golden.json")): ObserveCase[] {
  return (JSON.parse(readFileSync(path, "utf8")) as { cases: ObserveCase[] }).cases;
}

async function fire(kernel: Kernel, jobName: string): Promise<string> {
  const job = kernel.crons.list().find((j) => j.name === jobName)!;
  kernel.crons.update(job.id, { name: job.name, schedule: job.schedule, type: "self_prompt", prompt: job.prompt!, task: job.task, enabled: true });
  kernel.startCron();
  try {
    const r = await kernel.fireCron(job.id);
    await kernel.queue.drain();
    const result = r.outcome.fired ? (r.outcome.result as { finalText?: string }) : undefined;
    return result?.finalText ?? (r.error ?? "");
  } finally {
    kernel.stopCron();
  }
}

export async function runDreamEval(inference: Inference, cases: DreamCase[] = loadDreamGolden()): Promise<JobEvalReport> {
  const results: JobCaseResult[] = [];
  for (const c of cases) {
    const root = mkdtempSync(join(tmpdir(), "kos-dreameval-"));
    const kernel = await Kernel.boot({ rootDir: root, secrets: new SecretsRegistry(), inference, sessionless: true });
    try {
      const owner = kernel.profile.ownerId;
      for (const s of c.seed) {
        const q = splitQualified(s.key)!;
        const written = kernel.facts.upsert(owner, { key: q.key, value: s.value, kind: s.kind, scope: q.scope }, "seed");
        if (s.daysSinceUse) {
          const at = Date.now() - s.daysSinceUse * 86_400_000;
          kernel.workspace.db.prepare(`UPDATE memory_claims SET created_at = ?, updated_at = ?, last_used_at = ? WHERE id = ?`).run(at, at, at, written.id);
        }
      }
      const said = await fire(kernel, "kos.dream");
      const current = (q: string): boolean => {
        const p = splitQualified(q)!;
        return kernel.facts.get(owner, p.key, p.scope) !== undefined;
      };
      const archivedFor = (q: string): boolean => {
        const p = splitQualified(q)!;
        return kernel.facts.history(owner, p.key).some((h) => h.scope === p.scope && kernel.facts.trace(h.id)!.revisions.some((r) => r.action === "archive"));
      };
      const met: string[] = [];
      const missed: string[] = [];
      const harm: string[] = [];
      const check = (label: string, ok: boolean): void => { (ok ? met : missed).push(label); };
      // Either direction is a merge; which key survives is the model's call.
      for (const [a, b] of c.expect.merged ?? []) check(`merged ${a} and ${b} into one`, current(a) !== current(b));
      for (const q of c.expect.archived ?? []) check(`archived ${q}`, !current(q) && archivedFor(q));
      const kinds = kernel.review.pending().map((i) => i.kind);
      for (const k of c.expect.flagged ?? []) check(`flagged ${k}`, kinds.includes(k));
      for (const q of c.expect.kept ?? []) if (!current(q)) harm.push(`lost ${q}`);
      for (const name of c.expect.pages ?? []) {
        const text = readPage(kernel.workspace, name) ?? "";
        check(`page ${name} with claim lines`, text.split("\n").some((l) => CLAIM_LINE.test(l)));
      }
      results.push({ name: c.name, met, missed, harm, said });
    } finally {
      kernel.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
  return summarize("dream", results);
}

export async function runObserveEval(inference: Inference, cases: ObserveCase[] = loadObserveGolden()): Promise<JobEvalReport> {
  const results: JobCaseResult[] = [];
  for (const c of cases) {
    const root = mkdtempSync(join(tmpdir(), "kos-observeeval-"));
    const kernel = await Kernel.boot({ rootDir: root, secrets: new SecretsRegistry(), inference, sessionless: true });
    try {
      const owner = kernel.profile.ownerId;
      const convo = kernel.conversations.create({ userId: owner, title: c.name });
      const history = c.turns.map(([who, text]) => ({ role: who === "owner" ? ("user" as const) : ("assistant" as const), content: [{ type: "text" as const, text }] }));
      kernel.sessions.configure({ autoTrim: false });
      kernel.sessions.set(convo.id, history);
      // A budget the size of the thread, so a short synthetic one counts as long.
      kernel.sessions.configure({ maxChars: JSON.stringify(history).length, autoTrim: false });
      const said = await fire(kernel, "kos.observe");
      const notes = kernel.workspace.db.prepare(`SELECT text, covered FROM memory_observations WHERE conversation_id = ?`).all(convo.id) as { text: string; covered: number }[];
      const met: string[] = [];
      const missed: string[] = [];
      const harm: string[] = [];
      if (notes.length === 0) {
        missed.push("a note was written");
      } else {
        met.push("a note was written");
        const note = notes.map((n) => n.text).join("\n").toLowerCase();
        for (const w of c.mustMention) (note.includes(w.toLowerCase()) ? met : missed).push(`mentions ${w}`);
        for (const w of c.mustNotMention) if (note.includes(w.toLowerCase())) harm.push(`mentions ${w}, which was not covered or not true`);
        const kept = kernel.sessions.get(convo.id).length;
        (kept < c.turns.length ? met : missed).push("the thread got shorter");
      }
      results.push({ name: c.name, met, missed, harm, said });
    } finally {
      kernel.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
  return summarize("observe", results);
}

function summarize(job: "dream" | "observe", results: JobCaseResult[]): JobEvalReport {
  const met = results.reduce((n, r) => n + r.met.length, 0);
  const all = results.reduce((n, r) => n + r.met.length + r.missed.length, 0);
  return { job, cases: results, score: all === 0 ? 1 : met / all, clean: results.filter((r) => r.harm.length === 0).length, total: results.length };
}

export function renderJobEvalReport(report: JobEvalReport): string {
  const lines = [`memory ${report.job} eval: ${(report.score * 100).toFixed(0)}% of expectations met, clean ${report.clean}/${report.total}`, ""];
  for (const r of report.cases) {
    lines.push(`- ${r.name}: ${r.met.length}/${r.met.length + r.missed.length}${r.harm.length ? ` | HARM ${r.harm.join("; ")}` : ""}`);
    for (const m of r.missed) lines.push(`    missed: ${m}`);
    if (r.said) lines.push(`    said: ${r.said.slice(0, 160)}`);
  }
  return lines.join("\n");
}
