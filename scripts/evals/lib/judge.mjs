// A model judge, for the few checkpoints no state can settle: Claude Haiku through the Claude
// Agent SDK (the owner's subscription, as KOS's own chats run), one turn, no tools, a fixed rubric.
// The SDK takes no temperature; the rubric asks for a yes or no with one reason, and both are kept.

import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SYSTEM = 'You grade an assistant\'s answer against a rubric. Reply with JSON only, no prose: {"pass": true|false, "reason": "one sentence"}. Pass only if every point of the rubric holds.';

export function makeJudge(root, model = process.env.KOS_EVAL_JUDGE ?? "claude-haiku-4-5") {
  /** @returns {Promise<{ pass: boolean, reason: string, model: string }>} */
  return async function judge(rubric, answer) {
    try {
      const { query } = await import(pathToFileURL(join(root, "packages/harness/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs")).href);
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 90_000);
      let text = "";
      try {
        for await (const m of query({ prompt: `Rubric:\n${rubric}\n\nAnswer to grade:\n"""\n${answer}\n"""`, options: { model, maxTurns: 1, allowedTools: [], disallowedTools: ["Bash", "Read", "Write", "Edit", "WebFetch", "WebSearch", "Task", "Glob", "Grep"], systemPrompt: SYSTEM, abortController: abort, settingSources: [] } })) {
          if (m.type === "result" && typeof m.result === "string") text = m.result;
        }
      } finally {
        clearTimeout(timer);
      }
      const v = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
      return { pass: v.pass === true, reason: String(v.reason ?? ""), model: `${model} (sdk)` };
    } catch (err) {
      return { pass: false, reason: `judge failed: ${err.message}`, model: `${model} (sdk)` };
    }
  };
}
