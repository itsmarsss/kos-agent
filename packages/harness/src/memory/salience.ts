/**
 * Salience heuristics: decide what is worth remembering at write time. Fast
 * deterministic patterns catch obvious durables ("my X is Y", preferences,
 * accounts, absolutes). Statements that only "maybe" matter are flagged for an
 * optional LLM confirmation pass (see MemoryWriter); the rest are skipped.
 */

export type SalienceVerdict = "durable" | "maybe" | "skip";

export type FactKind = "fact" | "preference";

export interface CandidateFact {
  key: string;
  value: string;
  kind: FactKind;
}

export interface SalienceResult {
  verdict: SalienceVerdict;
  /** Heuristic signals that fired, for debugging and the memory peek UI. */
  signals: string[];
  candidates: CandidateFact[];
}

const MY_X_IS = /\bmy ([a-z][\w ]{0,40}?) (?:is|are)\s+([^.!?\n]{1,100})/i;
const PREFER =
  /\bi (?:prefer|like|love|favou?r|always use|usually use)\s+([^.!?\n]{1,100})/i;
const ABSOLUTE = /\b(always|never)\b/i;
const ACCOUNT = /\b(account|username|email|api key|password|login|handle)\b/i;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const FIRST_PERSON = /\bi(?:'m| am| have| use| work| live)\b/i;

function slug(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function assessSalience(text: string): SalienceResult {
  const signals: string[] = [];
  const candidates: CandidateFact[] = [];

  const myMatch = MY_X_IS.exec(text);
  if (myMatch) {
    const key = slug(myMatch[1] ?? "");
    const value = (myMatch[2] ?? "").trim();
    if (key && value) {
      candidates.push({ key, value, kind: "fact" });
      signals.push("my_x_is");
    }
  }

  const prefMatch = PREFER.exec(text);
  if (prefMatch) {
    const value = (prefMatch[1] ?? "").trim();
    if (value) {
      candidates.push({ key: `prefers:${slug(value)}`, value, kind: "preference" });
      signals.push("preference");
    }
  }

  if (ACCOUNT.test(text) || EMAIL.test(text)) signals.push("account");
  if (ABSOLUTE.test(text)) signals.push("absolute");

  let verdict: SalienceVerdict;
  if (candidates.length > 0 || signals.includes("account")) {
    verdict = "durable";
  } else if (signals.includes("absolute") || FIRST_PERSON.test(text)) {
    verdict = "maybe";
  } else {
    verdict = "skip";
  }

  return { verdict, signals, candidates };
}
