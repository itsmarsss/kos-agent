import { existsSync, readFileSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { ToolDef } from "../models/types.js";
import type { KosModule, ModuleContext } from "../modules/loader.js";
import { resolvePath } from "../jail/resolvePath.js";
import { childEnv } from "../sandbox/env.js";
import { injectSecrets } from "../secrets/inject.js";
import type { SecretsRegistry } from "../secrets/secrets.js";
import type { RiskTier } from "../risk/tiers.js";

/**
 * Tools from MCP servers, offered like any other.
 *
 * A server is named in `mcp.json` at the workspace root, in the shape Claude
 * Code uses so a config written for one works for the other. Each tool the
 * server lists is registered as `mcp.<server>.<tool>`, with the server's
 * description and input schema, and a call goes straight through. Both
 * engines read the one registry, so a tool from a server works wherever any
 * other tool does.
 *
 * Risk: a server is somebody else's code, so its tools are `risky` unless the
 * owner says `"risk": "safe"` for that server. The harness classifies; the
 * server does not get a vote.
 *
 * Secrets: `{{secret:NAME}}` in a server's env or headers is substituted at
 * connect time and never written to a log. The config file itself holds only
 * the reference.
 *
 * Isolation: a server that fails to start or list its tools is reported and
 * skipped. It is not a reason for the rest of the toolkit, or the host, to
 * fail.
 */

export const MCP_CONFIG_FILE = "mcp.json";

export interface McpServerConfig {
  /** Spawned over stdio. Mutually exclusive with `url`. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Reached over streamable HTTP. Mutually exclusive with `command`. */
  url?: string;
  headers?: Record<string, string>;
  /** Off without deleting it. Default on. */
  enabled?: boolean;
  /** Floor for every tool this server provides. Default risky. */
  risk?: Extract<RiskTier, "safe" | "risky">;
  /**
   * A floor per tool, overriding the server default.
   *
   * A key is the tool's own name (navigate, click), or a glob over it
   * (browser_*, *_get). This is how a browser becomes usable without a tap
   * per action: read-only tools (navigate, snapshot, find) are made safe
   * while the ones that change the page (click, type, fill_form) stay risky.
   * The owner writes these; the harness never guesses a tool is safe.
   */
  tools?: Record<string, Extract<RiskTier, "safe" | "risky">>;
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

/** Read and validate the config, or an empty one where there is no file. */
export function readMcpConfig(workspaceRoot: string): McpConfig {
  const path = resolvePath(workspaceRoot, MCP_CONFIG_FILE);
  if (!existsSync(path)) return { servers: {} };
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return parseMcpConfig(raw);
}

export function parseMcpConfig(raw: unknown): McpConfig {
  if (typeof raw !== "object" || raw === null) return { servers: {} };
  const servers = (raw as { servers?: unknown }).servers;
  if (typeof servers !== "object" || servers === null) return { servers: {} };
  const out: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const v = value as Record<string, unknown>;
    const entry: McpServerConfig = {};
    if (typeof v["command"] === "string" && v["command"].trim()) entry.command = v["command"].trim();
    if (Array.isArray(v["args"])) entry.args = v["args"].filter((a): a is string => typeof a === "string");
    if (isStringMap(v["env"])) entry.env = v["env"];
    if (typeof v["url"] === "string" && v["url"].trim()) entry.url = v["url"].trim();
    if (isStringMap(v["headers"])) entry.headers = v["headers"];
    if (typeof v["enabled"] === "boolean") entry.enabled = v["enabled"];
    if (v["risk"] === "safe" || v["risk"] === "risky") entry.risk = v["risk"];
    if (typeof v["tools"] === "object" && v["tools"] !== null) {
      const floors: Record<string, "safe" | "risky"> = {};
      for (const [tool, floor] of Object.entries(v["tools"] as Record<string, unknown>)) {
        if (floor === "safe" || floor === "risky") floors[tool] = floor;
      }
      if (Object.keys(floors).length) entry.tools = floors;
    }
    // One transport or the other. Neither is a typo, both is a contradiction.
    if ((entry.command === undefined) === (entry.url === undefined)) continue;
    out[name] = entry;
  }
  return { servers: out };
}

function isStringMap(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value as Record<string, unknown>).every((x) => typeof x === "string")
  );
}

/** Match a glob (only * is special) against a tool name. */
function globMatch(pattern: string, name: string): boolean {
  const re = new RegExp(
    `^${pattern.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`,
  );
  return re.test(name);
}

/**
 * The floor for one of a server's tools.
 *
 * An exact name wins over a glob, a glob over the server default, the server
 * default over the built-in risky. Globs are tried in the order the owner
 * wrote them, so a specific one can precede a catch-all.
 */
export function floorFor(
  server: McpServerConfig,
  toolName: string,
): Extract<RiskTier, "safe" | "risky"> {
  const fallback = server.risk ?? "risky";
  const tools = server.tools;
  if (!tools) return fallback;
  if (toolName in tools) return tools[toolName]!;
  for (const [pattern, floor] of Object.entries(tools)) {
    if (pattern.includes("*") && globMatch(pattern, toolName)) return floor;
  }
  return fallback;
}

/** `mcp.<server>.<tool>`, each part reduced to what a tool name may hold. */
export function mcpToolName(server: string, tool: string): string {
  const part = (s: string): string => s.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return `mcp.${part(server)}.${part(tool)}`;
}

/** What a call produced, as text the model can read. */
export function renderContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const b = block as { type?: string; text?: string; mimeType?: string; resource?: { uri?: string; text?: string } };
      if (b.type === "text") return b.text ?? "";
      if (b.type === "image") return b.mimeType ? `[image ${b.mimeType}]` : "[image]";
      if (b.type === "resource") return b.resource?.text ?? `[resource ${b.resource?.uri ?? ""}]`;
      return `[${b.type ?? "content"}]`;
    })
    .filter((s) => s !== "")
    .join("\n");
}

export interface McpModuleOptions {
  workspaceRoot: string;
  secrets: SecretsRegistry;
  /** Where to read servers from. Defaults to mcp.json in the workspace. */
  config?: () => McpConfig;
  /**
   * How to reach a server. Defaults to stdio or streamable HTTP as the config
   * says; a test supplies an in-memory transport here instead of spawning.
   */
  transportFor?: (name: string, server: McpServerConfig) => Transport | undefined;
  /** Where a failed server is reported. Defaults to the console. */
  report?: (message: string) => void;
}

interface Connected {
  client: Client;
  tools: string[];
}

/**
 * The module, plus a way to close what it opened.
 *
 * A stdio server is a child process that must not outlive the host, so the
 * module deactivates by closing every connection it opened.
 */
export function createMcpModule(options: McpModuleOptions): KosModule {
  const report = options.report ?? ((m: string) => console.error(`[mcp] ${m}`));
  const connected = new Map<string, Connected>();

  const transportFor = (name: string, server: McpServerConfig): Transport => {
    const supplied = options.transportFor?.(name, server);
    if (supplied) return supplied;
    if (server.command) {
      return new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        // The same hygiene as any child KOS spawns: an allow-list of host
        // variables, HOME inside the workspace, and only this server's own
        // settings on top, secrets already substituted.
        env: childEnv({ home: options.workspaceRoot }, injectSecrets(server.env ?? {}, options.secrets)),
        cwd: options.workspaceRoot,
        stderr: "ignore",
      });
    }
    const headers = injectSecrets(server.headers ?? {}, options.secrets);
    return new StreamableHTTPClientTransport(new URL(server.url!), {
      requestInit: Object.keys(headers).length ? { headers } : {},
    });
  };

  async function connect(name: string, server: McpServerConfig): Promise<Connected> {
    const client = new Client({ name: "kos", version: "1.0.0" });
    await client.connect(transportFor(name, server));
    const listed = await client.listTools();
    return { client, tools: listed.tools.map((t) => t.name) };
  }

  const module: KosModule = {
    manifest: {
      name: "mcp",
      version: "1.0.0",
      provides: [],
      riskTier: "risky",
    },
    async activate(ctx: ModuleContext) {
      const config = (options.config ?? (() => readMcpConfig(options.workspaceRoot)))();
      for (const [name, server] of Object.entries(config.servers)) {
        if (server.enabled === false) continue;
        let link: Connected;
        try {
          link = await connect(name, server);
        } catch (err) {
          report(`${name}: not connected (${err instanceof Error ? err.message : String(err)})`);
          continue;
        }
        connected.set(name, link);
        const listed = await link.client.listTools();
        for (const tool of listed.tools) {
          const def: ToolDef = {
            name: mcpToolName(name, tool.name),
            description: tool.description ?? `${tool.name} from ${name}`,
            inputSchema: (tool.inputSchema as Record<string, unknown>) ?? { type: "object" },
          };
          try {
            ctx.registerTool(
              def,
              async (input) => {
                const live = connected.get(name) ?? (await reconnect(name, server));
                const result = await live.client.callTool({ name: tool.name, arguments: input });
                const text = renderContent(result.content);
                if (result.isError) throw new Error(text || `${tool.name} reported an error`);
                return text;
              },
              { floor: floorFor(server, tool.name) },
            );
          } catch (err) {
            // A name already taken is this tool's problem, not the server's.
            report(`${def.name}: not registered (${err instanceof Error ? err.message : String(err)})`);
          }
        }
      }
    },
  };

  async function reconnect(name: string, server: McpServerConfig): Promise<Connected> {
    const link = await connect(name, server);
    connected.set(name, link);
    return link;
  }

  async function close(): Promise<void> {
    for (const [name, link] of connected) {
      try {
        await link.client.close();
      } catch {
        // Already gone. The point was that it is not running any more.
      }
      connected.delete(name);
    }
  }

  return { ...module, deactivate: close };
}
