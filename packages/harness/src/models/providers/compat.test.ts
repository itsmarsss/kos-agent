import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OpenAICompatibleProvider, toChatMessages } from "./compat.js";

describe("an OpenAI-compatible endpoint", () => {
  let server: Server;
  let baseURL: string;
  let seen: { path: string; auth?: string; body: Record<string, unknown> }[];
  let answer: (body: Record<string, unknown>) => unknown;

  beforeEach(async () => {
    seen = [];
    answer = () => ({});
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => { raw += c.toString(); });
      req.on("end", () => {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        seen.push({ path: req.url ?? "", ...(req.headers.authorization ? { auth: req.headers.authorization } : {}), body });
        if (req.url === "/v1/models") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ object: "list", data: [{ id: "local-7b" }, { id: "big-70b" }] }));
          return;
        }
        if (body["stream"] === true) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          const chunks = [
            { choices: [{ index: 0, delta: { content: "Hel" } }] },
            { choices: [{ index: 0, delta: { content: "lo" } }] },
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "files__read", arguments: '{"pa' } }] } }] },
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.md"}' } }] }, finish_reason: "tool_calls" }] },
            { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 }, model: "local-7b" },
          ];
          for (const c of chunks) res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "local-7b", ...c })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(answer(body)));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("speaks chat completions with tools, and reads a tool call back", async () => {
    answer = () => ({
      id: "r", object: "chat.completion", created: 0, model: "local-7b",
      choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "files__read", arguments: '{"path":"a.md"}' } }] } }],
      usage: { prompt_tokens: 12, completion_tokens: 4 },
    });
    const p = new OpenAICompatibleProvider(baseURL);
    const res = await p.generate(
      { system: "be brief", messages: [{ role: "user", content: [{ type: "text", text: "read a.md" }] }], tools: [{ name: "files.read", description: "read", inputSchema: { type: "object" } }] },
      { model: "local-7b" },
      "k3y",
    );
    expect(res.content).toEqual([{ type: "tool_use", id: "c1", name: "files.read", input: { path: "a.md" } }]);
    expect(res.stopReason).toBe("tool_use");
    expect(res.usage).toEqual({ inputTokens: 12, outputTokens: 4 });
    expect(seen[0]).toMatchObject({ path: "/v1/chat/completions", auth: "Bearer k3y" });
    const body = seen[0]!.body as { messages: unknown[]; tools: { function: { name: string } }[]; model: string };
    expect(body.model).toBe("local-7b");
    expect(body.messages[0]).toEqual({ role: "system", content: "be brief" });
    expect(body.tools[0]!.function.name).toBe("files__read");
  });

  it("streams text to a watcher and assembles a tool call from its pieces", async () => {
    const deltas: string[] = [];
    const p = new OpenAICompatibleProvider(baseURL);
    const res = await p.generate(
      { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], onDelta: (d) => { deltas.push(d.text); } },
      { model: "local-7b" },
      "",
    );
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(res.content).toEqual([{ type: "text", text: "Hello" }, { type: "tool_use", id: "c1", name: "files.read", input: { path: "a.md" } }]);
    expect(res.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    // No key: still a request, with a placeholder the endpoint can ignore.
    expect(seen[0]!.auth).toBe("Bearer none");
  });

  it("replays a transcript the way chat completions wants it", () => {
    const msgs = toChatMessages({
      system: "s",
      messages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "c1", name: "sql", input: { sql: "select 1" } }] },
        { role: "user", content: [{ type: "tool_result", toolUseId: "c1", content: "1" }] },
      ],
    });
    expect(msgs.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect((msgs[2] as { tool_calls: { function: { name: string } }[] }).tool_calls[0]!.function.name).toBe("sql");
    expect(msgs[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "1" });
  });

  it("lists what the endpoint serves", async () => {
    expect(await new OpenAICompatibleProvider(baseURL).listModels("")).toEqual(["big-70b", "local-7b"]);
  });
});
