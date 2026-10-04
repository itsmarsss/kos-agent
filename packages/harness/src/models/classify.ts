import type { Inference } from "../agent/loop.js";
import { textOf } from "./types.js";

/**
 * Classification beside generation.
 *
 * Many of the cheap questions KOS asks are not "write me something" but
 * "which of these" or "how much": is this message worth remembering, is
 * this worth interrupting the owner for, which project is this about. A
 * classifier answers those in a typed shape with a confidence, faster and
 * cheaper than a chat completion. The contract is small on purpose so a
 * dedicated model (TypeSafe AI's Jev, or any endpoint that speaks it) can
 * fill it; until one is configured, the cheap chat route stands in.
 */

export interface ChoiceRequest {
  kind: "choice";
  /** What to decide, in a sentence. */
  question: string;
  /** The text being judged. */
  text: string;
  labels: string[];
}

export interface ScoreRequest {
  kind: "score";
  question: string;
  text: string;
  /** Inclusive bounds; default 0 to 1. */
  range?: [number, number];
}

export type ClassifyRequest = ChoiceRequest | ScoreRequest;

export interface Classification {
  /** The chosen label, or the score as a string. */
  label: string;
  score?: number;
  /** 0 to 1, as the model reports it or as the fallback infers it. */
  confidence: number;
  provider: string;
}

export interface Classifier {
  readonly name: string;
  classify(req: ClassifyRequest): Promise<Classification>;
}

function clamp01(n: unknown, fallback = 0.5): number {
  return typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

/** Read a reply of the shape {label, confidence} or {score, confidence}, however it is wrapped. */
export function parseClassification(raw: unknown, req: ClassifyRequest, provider: string): Classification | undefined {
  let parsed = raw;
  if (typeof raw === "string") {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end <= start) return undefined;
    try {
      parsed = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const o = parsed as Record<string, unknown>;
  const inner = typeof o["result"] === "object" && o["result"] !== null ? (o["result"] as Record<string, unknown>) : o;
  const confidence = clamp01(inner["confidence"] ?? inner["probability"]);
  if (req.kind === "choice") {
    const label = [inner["label"], inner["choice"], inner["answer"], inner["output"]].find((v): v is string => typeof v === "string");
    if (!label) return undefined;
    const match = req.labels.find((l) => l.toLowerCase() === label.trim().toLowerCase());
    if (!match) return undefined;
    return { label: match, confidence, provider };
  }
  const score = [inner["score"], inner["value"], inner["output"]].map(Number).find((n) => Number.isFinite(n));
  if (score === undefined) return undefined;
  const [lo, hi] = req.range ?? [0, 1];
  const bounded = Math.min(hi, Math.max(lo, score));
  return { label: String(bounded), score: bounded, confidence, provider };
}

/**
 * Any endpoint that takes the request as JSON and answers with a label or
 * score and a confidence. The owner's classifier: a URL and, if it wants
 * one, a key. Jev speaks a shape like this; so could a small model of the
 * owner's own behind a few lines of server.
 */
export class HttpClassifier implements Classifier {
  readonly name = "classifier";

  constructor(private readonly options: { url: string; apiKey?: string; timeoutMs?: number; fetchImpl?: typeof fetch }) {}

  async classify(req: ClassifyRequest): Promise<Classification> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const res = await fetchImpl(this.options.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}) },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
    });
    if (!res.ok) throw new Error(`classifier: ${res.status} ${await res.text()}`);
    const parsed = parseClassification(await res.json(), req, this.name);
    if (!parsed) throw new Error("classifier: answer was not a label or score");
    return parsed;
  }
}

/** The cheap chat route answering the same question in JSON. The floor when no classifier is configured. */
export class LlmClassifier implements Classifier {
  readonly name = "llm";

  constructor(private readonly inference: Inference) {}

  async classify(req: ClassifyRequest): Promise<Classification> {
    const ask =
      req.kind === "choice"
        ? `${req.question}\nAnswer with JSON only: {"label": one of ${JSON.stringify(req.labels)}, "confidence": 0 to 1}.`
        : `${req.question}\nAnswer with JSON only: {"score": a number from ${(req.range ?? [0, 1])[0]} to ${(req.range ?? [0, 1])[1]}, "confidence": 0 to 1}.`;
    const response = await this.inference.generate("cheap", {
      system: "You classify text. Reply with the JSON asked for and nothing else.",
      messages: [{ role: "user", content: [{ type: "text", text: `${ask}\n\nText:\n${req.text}` }] }],
      maxTokens: 80,
    });
    const parsed = parseClassification(textOf(response.content), req, this.name);
    if (parsed) return parsed;
    // An unreadable answer is the least confident answer there is.
    return req.kind === "choice" ? { label: req.labels[0]!, confidence: 0, provider: this.name } : { label: "0", score: 0, confidence: 0, provider: this.name };
  }
}
