/**
 * How much a model can be told at once.
 *
 * Only used to turn a token count into a proportion, so an entry missing here
 * costs a percentage and nothing else: the count itself comes from the
 * provider and is always shown. That is deliberate. A wrong window would
 * produce a confident "12% used" that is really 60%, and the owner would find
 * out by being truncated rather than by being warned.
 *
 * So this is matched on prefixes that have been stable across releases, and
 * anything unrecognised returns undefined rather than a guess.
 */

const WINDOWS: { prefix: string; tokens: number }[] = [
  // Longest prefixes first: the 1M variants are distinct models, not options.
  { prefix: "claude-sonnet-4-5", tokens: 1_000_000 },
  { prefix: "claude-opus-4", tokens: 200_000 },
  { prefix: "claude-haiku-4", tokens: 200_000 },
  { prefix: "claude-3", tokens: 200_000 },
  { prefix: "gpt-4.1", tokens: 1_047_576 },
  { prefix: "gpt-4o", tokens: 128_000 },
  { prefix: "o3", tokens: 200_000 },
  { prefix: "o4", tokens: 200_000 },
];

/** Context window in tokens, or undefined when this model is not known. */
export function contextWindowFor(model: string): number | undefined {
  const name = model.toLowerCase();
  let best: { prefix: string; tokens: number } | undefined;
  for (const entry of WINDOWS) {
    if (!name.startsWith(entry.prefix)) continue;
    if (!best || entry.prefix.length > best.prefix.length) best = entry;
  }
  return best?.tokens;
}
