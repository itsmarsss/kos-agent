import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { CallerClient } from "@kos/client";

/**
 * KOS memory as an MCP server, for another agent on this machine.
 *
 * `kos memory-mcp --url http://127.0.0.1:4317 --token kosc_...` speaks the
 * protocol over stdio and forwards to the host's caller API, so a Claude
 * Code session, a DeepSeek Harness, or anything else that takes an MCP
 * server reads and writes KOS memory within the caller's grant. The grant
 * is the owner's; this process adds nothing to it.
 */

export async function serveMemoryMcp(options: { baseUrl: string; token: string }): Promise<void> {
  const kos = new CallerClient(options);
  const server = new McpServer({ name: "kos-memory", version: "1.0.0" });
  const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] });

  server.registerTool(
    "memory_recall",
    { description: "What KOS remembers that you may see: your own claims and the owner's global claims under your granted tags. Words to match, or nothing for the latest.", inputSchema: { query: z.string().optional(), limit: z.number().optional() } },
    async ({ query, limit }) => text(await kos.recall(query, limit)),
  );
  server.registerTool(
    "memory_remember",
    { description: "Keep a claim under a stable snake_case key. Lands in your own scope unless scope is global and your grant allows it.", inputSchema: { key: z.string(), value: z.string(), kind: z.enum(["fact", "preference"]).optional(), tags: z.array(z.string()).optional(), scope: z.enum(["global"]).optional() } },
    async ({ key, value, kind, tags, scope }) => text(await kos.remember(key, value, { ...(kind ? { kind } : {}), ...(tags ? { tags } : {}), ...(scope ? { scope } : {}) })),
  );
  server.registerTool(
    "memory_forget",
    { description: "Forget one of your own claims by key.", inputSchema: { key: z.string() } },
    async ({ key }) => text(await kos.forget(key)),
  );
  server.registerTool(
    "memory_trace",
    { description: "Where a claim you may see came from, and what it replaced.", inputSchema: { key: z.string() } },
    async ({ key }) => text(await kos.trace(key)),
  );
  server.registerTool(
    "memory_ingest",
    { description: "Hand KOS your conversation so it is searchable later. Kept as the outside world's words, never as the owner's own.", inputSchema: { events: z.array(z.object({ role: z.enum(["owner", "agent"]), text: z.string(), conversation: z.string().optional() })) } },
    async ({ events }) => text(await kos.ingest(events)),
  );

  await server.connect(new StdioServerTransport());
}
