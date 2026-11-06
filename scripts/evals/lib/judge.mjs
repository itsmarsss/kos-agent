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

const LOOK = 'You grade a screenshot set of a document or app an assistant made, against a rubric. Reply with JSON only, no prose: {"score": 1-5, "pass": true|false, "reason": "two sentences"}. 5 is work a good designer would ship; 3 is serviceable but generic or flawed; 1 is broken. Pass only if the score is 4 or 5.';

/**
 * A judge that looks: the same model through the same SDK, shown pictures of what was made
 * (each labelled), with a fixed rubric. Returns a 1 to 5 score as well as the verdict.
 */
export function makeLookJudge(root, model = process.env.KOS_EVAL_JUDGE ?? "claude-haiku-4-5") {
  /** @returns {Promise<{ pass: boolean, score: number, reason: string, model: string }>} */
  return async function look(rubric, pictures) {
    try {
      const { query } = await import(pathToFileURL(join(root, "packages/harness/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs")).href);
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 120_000);
      const content = [{ type: "text", text: `Rubric:\n${rubric}` }];
      for (const p of pictures) content.push({ type: "text", text: p.label }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: p.data } });
      async function* prompt() {
        yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "" };
      }
      let text = "";
      try {
        for await (const m of query({ prompt: prompt(), options: { model, maxTurns: 1, allowedTools: [], disallowedTools: ["Bash", "Read", "Write", "Edit", "WebFetch", "WebSearch", "Task", "Glob", "Grep"], systemPrompt: LOOK, abortController: abort, settingSources: [] } })) {
          if (m.type === "result" && typeof m.result === "string") text = m.result;
        }
      } finally {
        clearTimeout(timer);
      }
      // The verdict, even when the reason's quotes break the JSON around it.
      const body = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
      let v;
      try {
        v = JSON.parse(body);
      } catch {
        v = { score: /"score"\s*:\s*(\d)/.exec(body)?.[1], reason: /"reason"\s*:\s*"([\s\S]*)"\s*}?\s*$/.exec(body)?.[1] ?? body };
      }
      const score = Number(v.score) || 0;
      return { pass: score >= 4, score, reason: String(v.reason ?? ""), model: `${model} (sdk)` };
    } catch (err) {
      return { pass: false, score: 0, reason: `judge failed: ${err.message}`, model: `${model} (sdk)` };
    }
  };
}
