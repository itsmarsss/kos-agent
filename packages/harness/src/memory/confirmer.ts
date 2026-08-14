import type { Inference } from "../agent/loop.js";
import { textOf } from "../models/types.js";
import type { CandidateFact, FactKind } from "./salience.js";
import type { SalienceConfirmer } from "./writer.js";

/**
 * The LLM half of hybrid salience. Heuristics catch obvious durables outright;
 * anything they only flag as "maybe" comes here to be confirmed and structured.
 * Routed to the cheap task class, because this runs on ordinary chat turns and
 * must never cost reasoning-model money.
 *
 * Without this wired, every "maybe" verdict is silently discarded and the fact
 * store only ever holds what two regexes matched.
 */

const SYSTEM = [
  "You extract durable personal facts from a message for an assistant's long-term memory.",
  "Durable means it stays true beyond this conversation: identities, relationships, accounts,",
  "preferences, constraints, recurring schedules, tools and services the person uses.",
  "Not durable: one-off requests, questions, task instructions, transient state, small talk.",
  "",
  'Reply with JSON only: {"facts":[{"key":"snake_case_id","value":"the fact","kind":"fact"|"preference"}]}',
  'Return {"facts":[]} when nothing is durable. Prefer returning nothing over guessing.',
  "Keys are short, stable, snake_case (timezone, employer, coffee_order). Values are self-contained.",
  "Never invent detail the message does not state. Never store secrets, passwords, or API keys.",
].join("\n");

const MAX_FACTS = 5;
const MAX_KEY_LENGTH = 60;
const MAX_VALUE_LENGTH = 300;

function normalizeKey(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_KEY_LENGTH);
  return key || undefined;
}

/** Parse the model's reply defensively; malformed output yields no facts. */
export function parseConfirmerReply(text: string): CandidateFact[] {
  // Models occasionally wrap JSON in prose or a fence; take the outermost object.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }

  const facts = (parsed as { facts?: unknown }).facts;
  if (!Array.isArray(facts)) return [];

  const out: CandidateFact[] = [];
  for (const entry of facts) {
    if (!entry || typeof entry !== "object") continue;
    const { key: rawKey, value: rawValue, kind: rawKind } = entry as Record<
      string,
      unknown
    >;
    const key = normalizeKey(rawKey);
    if (!key) continue;
    if (typeof rawValue !== "string" || rawValue.trim() === "") continue;
    const kind: FactKind = rawKind === "preference" ? "preference" : "fact";
    out.push({
      key,
      value: rawValue.trim().slice(0, MAX_VALUE_LENGTH),
      kind,
    });
    if (out.length >= MAX_FACTS) break;
  }
  return out;
}

export class LlmSalienceConfirmer implements SalienceConfirmer {
  constructor(private readonly inference: Inference) {}

  async confirm(
    text: string,
    candidates: CandidateFact[],
  ): Promise<CandidateFact[]> {
    const hint =
      candidates.length > 0
        ? `\n\nHeuristics already proposed: ${JSON.stringify(candidates)}. Correct or discard them as needed.`
        : "";

    const response = await this.inference.generate("cheap", {
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: `Message:\n${text}${hint}` }],
        },
      ],
    });

    return parseConfirmerReply(textOf(response.content));
  }
}
