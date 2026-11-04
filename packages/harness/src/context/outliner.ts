import type { Inference } from "../agent/loop.js";
import { textOf } from "../models/types.js";
import type { Outliner } from "./shelf.js";

const SYSTEM =
  "Outline a document for someone who may need to look things up in it later: its sections or parts, and the specific facts, names and numbers each holds. At most 120 words, plain text, no preamble.";

/**
 * The cheap model's outline of a big result, asked of it only when it is on
 * the provider the turn itself is on: a page read on one provider's account
 * is not sent to another to be summed up. Otherwise there is no outline, and
 * the stub says only what the result was and how to bring it back.
 */
export function outlinerFor(inference: Inference, turnProvider: () => string | undefined): Outliner {
  return async (text, what) => {
    const turn = turnProvider();
    if (!turn || inference.routeFor?.("cheap").provider !== turn) return undefined;
    // An outline is a help, never a wait: one that is slow to come is left out.
    const res = await inference.generate("cheap", {
      signal: AbortSignal.timeout(15_000),
      system: SYSTEM,
      messages: [{ role: "user", content: [{ type: "text", text: `${what}:\n\n${text.slice(0, 60_000)}` }] }],
    });
    return textOf(res.content);
  };
}
