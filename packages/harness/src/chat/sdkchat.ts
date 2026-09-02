import {
  createSdkMcpServer,
  query,
  tool,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type { ToolBox } from "../agent/loop.js";
import { credentials } from "../builds/runner.js";
import { toZodShape } from "./schema.js";

/**
 * A chat turn run by the Claude Agent SDK instead of the model API.
 *
 * The reason is money: builds already run on a Claude Code subscription, and
 * a chat turn is the same kind of work. This lets the owner spend the
 * subscription they already have rather than API credits.
 *
 * What must not change is containment. Claude Code brings its own Read,
 * Write, Edit and Bash, and none of them know about the workspace jail or
 * the risk tiers. So they are disallowed outright and KOS's own tools are
 * handed over as an in-process MCP server: the only way this turn can touch
 * anything is through the same guarded path a normal turn uses, with the same
 * approvals. If that list were ever to leak a built-in through, the jail
 * would be gone -- which is why the allow list is built by name from the
 * registry rather than left open.
 */

/** Claude Code's own tools. None of them go through KOS's gate. */
const BUILTINS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "NotebookRead",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "TodoWrite",
  "KillShell",
  "BashOutput",
];

/** The MCP name the SDK exposes KOS's tools under. */
const SERVER = "kos";

export interface SdkChatResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  /** True when the SDK stopped for its own reasons rather than answering. */
  stopped: boolean;
}

export interface SdkChatOptions {
  prompt: string;
  system: string;
  tools: ToolBox;
  cwd: string;
  model?: string;
  maxTurns?: number;
  /** Streamed reasoning and text, for the live view. */
  onDelta?: (delta: { kind: "reasoning" | "text"; text: string }) => void;
  env?: NodeJS.ProcessEnv;
}

/** Strip the MCP prefix the SDK adds, so callers see KOS's own tool names. */
export function plainName(name: string): string {
  const prefix = `mcp__${SERVER}__`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/** The SDK's name for one of KOS's tools. */
export function sdkName(name: string): string {
  return `mcp__${SERVER}__${name.replace(/\./g, "_")}`;
}

/**
 * Wrap the guarded toolbox as an in-process MCP server.
 *
 * Names are flattened because MCP tool names may not contain dots, and
 * mapped back before execution so the registry still sees files.read.
 */
function serverFor(tools: ToolBox) {
  const defined = tools.defs().map((spec) =>
    tool(
      spec.name.replace(/\./g, "_"),
      spec.description,
      toZodShape(spec.inputSchema),
      async (args: Record<string, unknown>) => {
        const result = await tools.execute(spec.name, args ?? {});
        return {
          content: [{ type: "text" as const, text: result.content }],
          ...(result.isError ? { isError: true } : {}),
        };
      },
    ),
  );
  return { server: createSdkMcpServer({ name: SERVER, tools: defined }), defined };
}

export async function runSdkChat(
  options: SdkChatOptions,
): Promise<SdkChatResult> {
  const { server } = serverFor(options.tools);
  const allowed = options.tools.defs().map((d) => sdkName(d.name));
  const { env, home } = credentials(options.cwd, options.env ?? process.env);

  let text = "";
  const usage = { inputTokens: 0, outputTokens: 0 };
  let stopped = false;

  const stream = query({
    prompt: options.prompt,
    options: {
      cwd: options.cwd,
      additionalDirectories: [],
      permissionMode: "default",
      // No user, project or local settings: the same isolation a build gets,
      // for the same reason. A permissions.allow rule written months ago must
      // not widen what a chat turn can do.
      settingSources: [],
      // Only KOS's tools exist. The built-ins are named individually as well
      // as excluded by the allow list, because an allow list that grows a
      // hole is a jail that quietly opens.
      allowedTools: allowed,
      disallowedTools: BUILTINS,
      mcpServers: { [SERVER]: server },
      maxTurns: options.maxTurns ?? 24,
      includePartialMessages: true,
      ...(options.model ? { model: options.model } : {}),
      env: { ...env, HOME: home },
      systemPrompt: { type: "preset", preset: "claude_code", append: options.system },
    },
  });

  for await (const message of stream as AsyncIterable<SDKMessage>) {
    const m = message as unknown as Record<string, unknown>;

    if (m["type"] === "stream_event") {
      const event = m["event"] as { delta?: { type?: string; text?: string; thinking?: string } };
      const delta = event?.delta;
      if (delta?.text) options.onDelta?.({ kind: "text", text: delta.text });
      if (delta?.thinking) {
        options.onDelta?.({ kind: "reasoning", text: delta.thinking });
      }
      continue;
    }

    if (m["type"] === "assistant") {
      const content = (m["message"] as { content?: unknown[] })?.content ?? [];
      for (const block of content) {
        const b = block as { type?: string; text?: string };
        if (b.type === "text" && b.text) text += b.text;
      }
      const u = (m["message"] as { usage?: Record<string, number> })?.usage;
      if (u) {
        usage.inputTokens += u["input_tokens"] ?? 0;
        usage.outputTokens += u["output_tokens"] ?? 0;
      }
      continue;
    }

    if (m["type"] === "result") {
      // A result with no text of its own is the SDK stopping rather than
      // answering: an error, or the turn limit.
      if (m["subtype"] !== "success") stopped = true;
      if (typeof m["result"] === "string" && !text) text = m["result"];
      break;
    }
  }

  return { text: text.trim(), usage, stopped };
}
