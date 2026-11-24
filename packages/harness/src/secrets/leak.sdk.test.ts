import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Inference } from "../agent/loop.js";
import type { ApprovalQueue } from "../ops/approvals.js";

/**
 * The leak suite's half for Claude Code: a chat turn on the SDK engine and a
 * build, each through the real Agent SDK with a stub in place of the CLI.
 * The stub does what the CLI does with what it is handed: it keeps a
 * transcript of the session under its config folder (CLAUDE_CONFIG_DIR, or
 * ~/.claude) unless told not to, holding every message and tool result,
 * where no scrubber runs. A chat turn's tool answers with a key; a build
 * reads a file in its folder that holds one. Afterwards no key is anywhere
 * under the temp HOME, and the CLI was handed no key a turn did not need.
 */

const stub = vi.hoisted(() => ({ path: "" }));

vi.mock("@anthropic-ai/claude-agent-sdk", async (actual) => {
  const real = await actual<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return { ...real, query: (args: Parameters<typeof real.query>[0]) => real.query({ ...args, options: { ...args.options, pathToClaudeCodeExecutable: stub.path } }) };
});

const { Kernel } = await import("../kernel/kernel.js");
const { BEHAVIOUR_KEY } = await import("../kernel/behaviour.js");
const { runBuild } = await import("../builds/runner.js");
const { SecretsRegistry } = await import("./secrets.js");
const { Workspace } = await import("../store/workspace.js");

/** The CLI as far as the SDK can tell, recording what it was handed in `dump`. */
const stubCli = (dump: string): string => `#!${process.execPath}
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const sid = randomUUID();
const cwd = process.cwd();
const persist = !argv.includes("--no-session-persistence");
const config = process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? "/nonexistent", ".claude");
const transcript = join(config, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), sid + ".jsonl");
const seen = (entry) => appendFileSync(${JSON.stringify(dump)}, JSON.stringify(entry) + "\\n");
const keep = (entry) => {
  if (!persist) return;
  mkdirSync(dirname(transcript), { recursive: true });
  appendFileSync(transcript, JSON.stringify({ ...entry, sessionId: sid, cwd }) + "\\n");
};
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const waiting = new Map();
let asked = 0;
const ask = (request) => new Promise((resolve) => {
  const id = "stub-" + ++asked;
  waiting.set(id, resolve);
  out({ type: "control_request", request_id: id, request });
});
const mcp = async (message) => (await ask({ subtype: "mcp_message", server_name: "kos", message })).response?.mcp_response;
let servers = [];
seen({ argv, env: process.env });

async function turn(user) {
  keep({ type: "user", message: user.message });
  out({ type: "system", subtype: "init", session_id: sid, cwd, tools: [], mcp_servers: [], model: "stub", permissionMode: "default", apiKeySource: "none" });
  const results = [];
  if (argv.includes("--permission-prompt-tool")) {
    // A build reads its folder, as its Read tool would.
    for (const name of readdirSync(cwd)) if (statSync(join(cwd, name)).isFile()) results.push(readFileSync(join(cwd, name), "utf8"));
  } else if (servers.includes("kos")) {
    await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stub", version: "0" } } });
    await mcp({ jsonrpc: "2.0", method: "notifications/initialized" });
    const listed = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tool = listed.result.tools.find((t) => /leaky/.test(t.name));
    const called = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: tool.name, arguments: {} } });
    results.push(JSON.stringify(called.result));
  }
  for (const content of results) {
    seen({ toolResult: content });
    keep({ type: "user", message: { role: "user", content: [{ type: "tool_result", content }] } });
  }
  const reply = { id: "msg_stub", role: "assistant", model: "stub", content: [{ type: "text", text: "Done." }], usage: { input_tokens: 0, output_tokens: 0 } };
  keep({ type: "assistant", message: reply });
  out({ type: "assistant", message: reply, parent_tool_use_id: null, session_id: sid });
  out({ type: "result", subtype: "success", result: "Done.", is_error: false, num_turns: 1, total_cost_usd: 0, duration_ms: 0, duration_api_ms: 0, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {}, permission_denials: [], session_id: sid });
}

createInterface({ input: process.stdin })
  .on("line", (line) => {
    const m = JSON.parse(line);
    seen({ stdin: m });
    if (m.type === "control_request" && m.request.subtype === "initialize") {
      servers = m.request.sdkMcpServers ?? [];
      out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: { commands: [], models: [], account: {} } } });
    } else if (m.type === "control_request") out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: {} } });
    else if (m.type === "control_response") waiting.get(m.response.request_id)?.(m.response);
    else if (m.type === "user") void turn(m);
  })
  .on("close", () => process.exit(0));
`;

const rand = (n: number): string => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => (b % 36).toString(36)).join("");

/** Every file under `dir`, as text. */
function filesUnder(dir: string): { path: string; text: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile())
    .map((path) => ({ path, text: readFileSync(path, "latin1") }));
}

describe("the leak suite on Claude Code: no key in what the CLI keeps", { timeout: 60_000 }, () => {
  let home: string;
  let root: string;
  let dump: string;
  const canary: Record<string, string> = {
    OPENAI_API_KEY: `sk-proj-${rand(40)}`,
    KOS_SECRET_STRIPE: `sk_live_${rand(28)}`,
    DISCORD_TOKEN: `env-${rand(24)}`,
  };
  const envWas: Record<string, string | undefined> = {};
  const setEnv = (name: string, value: string | undefined): void => {
    if (!(name in envWas)) envWas[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };

  /** Which canaries are in `text`, as they are or base64 or hex. */
  const leaks = (text: string, values: string[] = Object.values(canary)): string[] =>
    values.filter((c) => [c, Buffer.from(c).toString("base64").replace(/=+$/, ""), Buffer.from(c).toString("hex")].some((form) => text.includes(form)));
  /** What the CLI was handed, every line it recorded. */
  const handed = (): { argv?: string[]; env?: Record<string, string>; stdin?: unknown; toolResult?: string }[] =>
    existsSync(dump) ? readFileSync(dump, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, never>) : [];
  /** Every file under the temp HOME that holds a canary, by path. */
  const inHome = (): string[] => filesUnder(home).filter((f) => leaks(f.text).length > 0).map((f) => f.path);
  const transcripts = (): string[] => [join(home, ".claude", "projects"), join(home, ".kos", "claude", "projects")].flatMap((dir) => filesUnder(dir).map((f) => f.path));

  beforeAll(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "kos-leak-sdk-home-")));
    setEnv("HOME", home);
    for (const [name, value] of Object.entries(canary)) setEnv(name, value);
    setEnv("KOS_SECRET_STRIPE_HOSTS", "api.stripe.com");
  });

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "kos-leak-sdk-")));
    dump = join(root, "handed.jsonl");
    stub.path = join(root, "claude");
    writeFileSync(stub.path, stubCli(dump));
    chmodSync(stub.path, 0o755);
    // Signed in as the owner unless a case says otherwise: the path that keeps the owner's HOME.
    setEnv("ANTHROPIC_API_KEY", undefined);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(join(home, ".claude"), { recursive: true, force: true });
    rmSync(join(home, ".kos"), { recursive: true, force: true });
  });

  afterAll(() => {
    for (const [name, value] of Object.entries(envWas)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("keeps no transcript of a chat turn, and hands the CLI no key", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const inference: Inference = { generate: async () => ({ content: [{ type: "text", text: "ok" }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" }) };
    const kernel = await Kernel.boot({ rootDir: join(root, "ws"), secrets: SecretsRegistry.fromEnv(), inference, chrome: { port: 1, exists: () => false } });
    try {
      kernel.settings.set(BEHAVIOUR_KEY, { engine: "sdk" });
      kernel.registry.register({ name: "leaky", description: "answers with the keys", inputSchema: { type: "object" } }, () => `keys: ${Object.values(canary).join(" ")}`);
      const chat = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Keys" }).id;
      await kernel.handleChannelTurn({ text: "what keys are there?", userId: kernel.profile.ownerId, channel: "dashboard", conversationId: chat });
    } finally {
      kernel.close();
      vi.restoreAllMocks();
    }
    const results = handed().flatMap((h) => (h.toolResult ? [h.toolResult] : []));
    // The tool ran through the CLI, and what it answered went back scrubbed.
    expect(results.join("\n")).toContain("[secret openai]");
    expect(leaks(JSON.stringify(handed()))).toEqual([]);
    expect(transcripts()).toEqual([]);
    expect(inHome()).toEqual([]);
  });

  for (const signIn of ["the owner's sign-in", "an API key"] as const) {
    it(`keeps no transcript of a build, signed in with ${signIn}`, async () => {
      if (signIn === "an API key") setEnv("ANTHROPIC_API_KEY", `sk-ant-${rand(40)}`);
      const ws = Workspace.open(join(root, "ws"));
      try {
        mkdirSync(join(ws.root, "sites", "app"), { recursive: true });
        // What a build reads in its folder may hold a key: a config the owner left, a page it fetched.
        writeFileSync(join(ws.root, "sites", "app", "notes.txt"), `stripe ${canary["KOS_SECRET_STRIPE"]}`);
        const result = await runBuild({ workspace: ws, approvals: {} as ApprovalQueue, dir: "sites/app", task: "tidy the notes", timeoutMs: 20_000 });
        expect(result).toMatchObject({ ok: true, summary: "Done." });
      } finally {
        ws.close();
      }
      // The build read the key, as a build may; it was handed no other.
      expect(handed().some((h) => h.toolResult?.includes(canary["KOS_SECRET_STRIPE"]!))).toBe(true);
      expect(leaks(JSON.stringify(handed().filter((h) => !h.toolResult)))).toEqual([]);
      expect(transcripts()).toEqual([]);
      expect(inHome()).toEqual([]);
    });
  }
});
