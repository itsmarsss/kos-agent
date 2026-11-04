import { describe, expect, it, vi } from "vitest";

import type { ToolBox } from "../agent/loop.js";

/**
 * The turn as the SDK runs it, with the SDK played by a script: a query that
 * calls KOS's tools step by step, can be interrupted, and reports its turns.
 * What is under test is KOS's side: when a full query ends, what the fresh
 * one is given, that the step limit is the turn's, and whose words are whose.
 */

type Handler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text?: string }[] }>;
type Script = (q: Fake, tools: Map<string, Handler>) => AsyncGenerator<Record<string, unknown>>;
interface Fake {
  options: Record<string, unknown>;
  prompt: string;
  interrupted: boolean;
}

const run = vi.hoisted(() => ({ script: undefined as Script | undefined, queries: [] as Fake[] }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (name: string, _d: string, _s: unknown, handler: Handler) => ({ name, handler }),
  createSdkMcpServer: ({ tools }: { tools: { name: string; handler: Handler }[] }) => ({ tools: new Map(tools.map((t) => [t.name, t.handler])) }),
  query: ({ prompt, options }: { prompt: AsyncIterable<{ message: { content: { type: string; text?: string }[] } }>; options: Record<string, unknown> }) => {
    const q: Fake = { options, prompt: "", interrupted: false };
    run.queries.push(q);
    const tools = (options["mcpServers"] as Record<string, { tools: Map<string, Handler> }>)["kos"]!.tools;
    const stream = (async function* () {
      for await (const m of prompt) q.prompt = m.message.content.map((b) => b.text ?? `[${b.type}]`).join("\n");
      yield* run.script!(q, tools);
    })();
    return Object.assign(stream, { interrupt: async () => void (q.interrupted = true) });
  },
}));

const { runSdkChat } = await import("./sdkchat.js");

const picture = { data: "SU1H", mediaType: "image/jpeg" };
const box = (names: string[], answer: (name: string) => { content: string; images?: typeof picture[] }): ToolBox => ({
  defs: () => names.map((name) => ({ name, description: name, inputSchema: { type: "object", properties: {} } })),
  execute: async (name) => ({ ...answer(name), isError: false }),
});
const result = (turns: number, subtype = "success") => ({ type: "result", subtype, num_turns: turns, modelUsage: {}, total_cost_usd: 0, ...(subtype === "success" ? { result: "done" } : {}) });

/** Steps until `total` have been taken across queries, an interrupt ending the query it lands in. */
const steps = (total: number, name = "computer_act", done = { taken: 0 }): Script =>
  async function* (q, tools) {
    let turns = 0;
    while (done.taken < total && turns < (q.options["maxTurns"] as number)) {
      if (q.interrupted) {
        yield result(turns, "error_during_execution");
        return;
      }
      await tools.get(name)!({});
      done.taken += 1;
      turns += 1;
      yield { type: "user", parent_tool_use_id: null };
    }
    if (q.interrupted || done.taken < total) {
      yield result(turns, q.interrupted ? "error_during_execution" : "error_max_turns");
      return;
    }
    yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "All done." }] } };
    yield result(turns + 1);
  };

describe("a turn on the SDK", () => {
  it("ends a query once it has taken its pictures, and carries on in a fresh one from where it was", async () => {
    run.queries = [];
    run.script = steps(5);
    const r = await runSdkChat({ prompt: "Owner: finish the wizard", system: "s", tools: box(["computer.act"], () => ({ content: "Clicked.", images: [picture] })), cwd: process.cwd(), picturesPerQuery: 2, maxTurns: 20 });
    expect(r.calls).toHaveLength(5);
    expect(r.text).toBe("All done.");
    expect(r.stopped).toBe(false);
    expect(run.queries.length).toBe(3);
    // The fresh query has the task, the steps so far and the screen now.
    expect(run.queries[1]!.prompt).toContain("Owner: finish the wizard");
    expect(run.queries[1]!.prompt).toContain("do not repeat them or start over");
    expect(run.queries[1]!.prompt).toContain("[image]");
  });

  it("holds the turn to its step limit across every fresh query", async () => {
    run.queries = [];
    run.script = steps(50);
    const r = await runSdkChat({ prompt: "go", system: "s", tools: box(["computer.act"], () => ({ content: "Clicked.", images: [picture] })), cwd: process.cwd(), picturesPerQuery: 2, maxTurns: 5 });
    expect(r.calls.length).toBeLessThanOrEqual(5);
    expect(r.stopped).toBe(true);
    expect(run.queries.map((q) => q.options["maxTurns"])).toEqual([5, 3, 1]);
  });

  it("counts only a screen's pictures, not a plot or an MCP tool's", async () => {
    run.queries = [];
    run.script = steps(4, "python_run");
    await runSdkChat({ prompt: "plot it", system: "s", tools: box(["python.run"], () => ({ content: "plotted", images: [picture] })), cwd: process.cwd(), picturesPerQuery: 2, maxTurns: 20 });
    expect(run.queries).toHaveLength(1);
  });

  it("never ends the turn's query under a screen subagent, whose report would be lost", async () => {
    run.queries = [];
    run.script = steps(4);
    await runSdkChat({ prompt: "go", system: "s", tools: box(["computer.act", "files.read"], () => ({ content: "Clicked.", images: [picture] })), cwd: process.cwd(), picturesPerQuery: 2, maxTurns: 20, screen: { model: "claude-sonnet-5-5" } });
    expect(run.queries).toHaveLength(1);
  });

  it("keeps a subagent's words out of the reply and the live text, and shows its thinking", async () => {
    run.queries = [];
    run.script = async function* () {
      yield { type: "stream_event", parent_tool_use_id: "t1", event: { delta: { text: "subagent says" } } };
      yield { type: "stream_event", parent_tool_use_id: "t1", event: { delta: { thinking: "subagent thinks" } } };
      yield { type: "assistant", parent_tool_use_id: "t1", message: { content: [{ type: "text", text: "report for the turn" }] } };
      yield { type: "stream_event", parent_tool_use_id: null, event: { delta: { text: "The price is $16." } } };
      yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "The price is $16." }] } };
      yield result(2);
    };
    const deltas: { kind: string; text: string }[] = [];
    const r = await runSdkChat({ prompt: "price?", system: "s", tools: box(["files.read"], () => ({ content: "" })), cwd: process.cwd(), onDelta: (d) => void deltas.push(d) });
    expect(r.text).toBe("The price is $16.");
    expect(deltas).toEqual([
      { kind: "reasoning", text: "subagent thinks" },
      { kind: "text", text: "The price is $16." },
    ]);
  });
});
