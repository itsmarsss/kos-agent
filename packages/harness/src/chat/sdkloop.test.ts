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
  /** The stream was closed: left by its reader, or run to its end. */
  closed: boolean;
}

const run = vi.hoisted(() => ({ script: undefined as Script | undefined, queries: [] as Fake[] }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (name: string, _d: string, _s: unknown, handler: Handler) => ({ name, handler }),
  createSdkMcpServer: ({ tools }: { tools: { name: string; handler: Handler }[] }) => ({ tools: new Map(tools.map((t) => [t.name, t.handler])) }),
  query: ({ prompt, options }: { prompt: AsyncIterable<{ message: { content: { type: string; text?: string }[] } }>; options: Record<string, unknown> }) => {
    const q: Fake = { options, prompt: "", interrupted: false, closed: false };
    run.queries.push(q);
    const tools = (options["mcpServers"] as Record<string, { tools: Map<string, Handler> }>)["kos"]!.tools;
    const stream = (async function* () {
      try {
        for await (const m of prompt) q.prompt = m.message.content.map((b) => b.text ?? `[${b.type}]`).join("\n");
        yield* run.script!(q, tools);
      } finally {
        q.closed = true;
      }
    })();
    return Object.assign(stream, { interrupt: async () => void (q.interrupted = true) });
  },
}));

const { runSdkChat } = await import("./sdkchat.js");
const { STOPPED_RESULT } = await import("../kernel/guarded.js");

/** Never settles: the SDK's stream as it is for the two seconds after an abort, or a tool still running. */
const hang = (): Promise<never> => new Promise<never>(() => undefined);
/** Settles within `ms`, or says the turn was held. */
const within = <T>(ms: number, p: Promise<T>): Promise<T> =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`held past ${ms}ms`)), ms))]);

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
    let fresh = 0;
    const r = await runSdkChat({ prompt: "Owner: finish the wizard", system: "s", tools: box(["computer.act"], () => ({ content: "Clicked.", images: [picture] })), cwd: process.cwd(), picturesPerQuery: 2, maxTurns: 20, onFreshQuery: () => void (fresh += 1) });
    expect(r.calls).toHaveLength(5);
    // Told of each fresh query, so a tool that remembers what this query saw can forget it.
    expect(fresh).toBe(2);
    expect(r.text).toBe("All done.");
    expect(r.stopped).toBe(false);
    expect(run.queries.length).toBe(3);
    // The fresh query has the task, the steps so far and the screen now.
    expect(run.queries[1]!.prompt).toContain("Owner: finish the wizard");
    expect(run.queries[1]!.prompt).toContain("do not repeat them or start over");
    expect(run.queries[1]!.prompt).toContain("[image]");
  });

  it("offers KOS's tools alone, not the owner's claude.ai connectors", async () => {
    run.queries = [];
    run.script = steps(1, "notify");
    await runSdkChat({ prompt: "go", system: "s", tools: box(["notify"], () => ({ content: "ok" })), cwd: process.cwd() });
    const options = run.queries[0]!.options;
    expect(options["strictMcpConfig"]).toBe(true);
    expect(options["settings"]).toEqual({ disableClaudeAiConnectors: true });
    expect(Object.keys(options["mcpServers"] as object)).toEqual(["kos"]);
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

describe("a turn on the SDK the owner stops", () => {
  it("ends at once while the model is answering, interrupted and aborted, with what it had said", async () => {
    run.queries = [];
    run.script = async function* () {
      yield { type: "stream_event", parent_tool_use_id: null, event: { delta: { text: "The press began in Mainz" } } };
      await hang();
    };
    const stop = new AbortController();
    const r = await within(1_500, runSdkChat({ prompt: "essay", system: "s", tools: box([], () => ({ content: "" })), cwd: process.cwd(), signal: stop.signal, onDelta: () => stop.abort() }));
    expect(r.stopped).toBe(true);
    expect(r.text).toBe("The press began in Mainz");
    expect(run.queries[0]!.interrupted).toBe(true);
    expect((run.queries[0]!.options["abortController"] as AbortController).signal.aborted).toBe(true);
  });

  it("does not wait for a call under way, and keeps it, as stopped", async () => {
    run.queries = [];
    run.script = async function* (_q, tools) {
      await tools.get("python_run")!({});
      yield result(1);
    };
    const stop = new AbortController();
    const tools: ToolBox = {
      defs: () => [{ name: "python.run", description: "p", inputSchema: { type: "object", properties: {} } }],
      execute: () => {
        setTimeout(() => stop.abort(), 10);
        return hang();
      },
    };
    const r = await within(1_500, runSdkChat({ prompt: "sleep", system: "s", tools, cwd: process.cwd(), signal: stop.signal }));
    expect(r.calls).toEqual([expect.objectContaining({ name: "python.run", result: STOPPED_RESULT, isError: true })]);
  });

  it("waits a moment for the stopped query's account, and keeps its cost", async () => {
    run.queries = [];
    run.script = async function* (q) {
      yield { type: "stream_event", parent_tool_use_id: null, event: { delta: { text: "Mainz" } } };
      while (!q.interrupted) await new Promise((r) => setTimeout(r, 5));
      yield { type: "stream_event", parent_tool_use_id: null, event: { delta: { text: " and then" } } };
      yield { ...result(1, "error_during_execution"), total_cost_usd: 0.25, modelUsage: { "claude-x": { inputTokens: 900, outputTokens: 40, costUSD: 0.25 } } };
      await hang();
    };
    const stop = new AbortController();
    const started = Date.now();
    const r = await runSdkChat({ prompt: "essay", system: "s", tools: box([], () => ({ content: "" })), cwd: process.cwd(), signal: stop.signal, onDelta: () => stop.abort() });
    expect(Date.now() - started).toBeLessThan(500);
    expect(r).toMatchObject({ stopped: true, text: "Mainz", costUSD: 0.25, usage: { inputTokens: 900, outputTokens: 40 } });
    expect((run.queries[0]!.options["abortController"] as AbortController).signal.aborted).toBe(true);
  });

  it("waits no more than a moment for it, and keeps what the stream showed", async () => {
    run.queries = [];
    run.script = async function* () {
      yield { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "m1", model: "claude-x", usage: { input_tokens: 700, output_tokens: 1 } } } };
      yield { type: "stream_event", parent_tool_use_id: null, event: { delta: { text: "Mainz" } } };
      await hang();
    };
    const stop = new AbortController();
    const started = Date.now();
    const r = await runSdkChat({ prompt: "essay", system: "s", tools: box([], () => ({ content: "" })), cwd: process.cwd(), signal: stop.signal, onDelta: () => stop.abort() });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(r).toMatchObject({ stopped: true, text: "Mainz", costUSD: 0, usage: { inputTokens: 700, outputTokens: 1 } });
    expect(r.models).toEqual([expect.objectContaining({ model: "claude-x", inputTokens: 700 })]);
  });

  it("starts no fresh query once stopped", async () => {
    run.queries = [];
    run.script = steps(5);
    const stop = new AbortController();
    const r = await runSdkChat({ prompt: "go", system: "s", tools: box(["computer.act"], () => ({ content: "Clicked.", images: [picture] })), cwd: process.cwd(), picturesPerQuery: 1, maxTurns: 20, signal: stop.signal, onFreshQuery: () => stop.abort() });
    expect(run.queries).toHaveLength(1);
    expect(r.stopped).toBe(true);
  });

  it("closes each query it leaves, so the next one can have the tools", async () => {
    run.queries = [];
    run.script = steps(3);
    await runSdkChat({ prompt: "go", system: "s", tools: box(["computer.act"], () => ({ content: "Clicked.", images: [picture] })), cwd: process.cwd(), picturesPerQuery: 1, maxTurns: 20, signal: new AbortController().signal });
    expect(run.queries.length).toBeGreaterThan(1);
    expect(run.queries.every((q) => q.closed)).toBe(true);
  });
});
