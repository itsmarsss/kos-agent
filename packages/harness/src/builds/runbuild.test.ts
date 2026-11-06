import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { ApprovalQueue } from "../ops/approvals.js";
import { Workspace } from "../store/workspace.js";

/** The options a build's query is started with, the SDK played by a stub that finishes at once. */
const seen = vi.hoisted(() => ({ options: undefined as Record<string, unknown> | undefined }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ options }: { options: Record<string, unknown> }) => {
    seen.options = options;
    const stream = (async function* () {
      yield { type: "result", subtype: "success", result: "built", num_turns: 1, total_cost_usd: 0, usage: {} };
    })();
    return Object.assign(stream, { interrupt: async () => undefined });
  },
}));

const { runBuild } = await import("./runner.js");

describe("a build's query", () => {
  it("reaches no MCP server, and none of the owner's claude.ai connectors", async () => {
    const root = mkdtempSync(join(tmpdir(), "kos-build-"));
    const ws = Workspace.open(root);
    try {
      await runBuild({ workspace: ws, approvals: {} as ApprovalQueue, dir: "sites/x", task: "make it", timeoutMs: 5_000 });
      expect(seen.options?.["strictMcpConfig"]).toBe(true);
      expect(seen.options?.["settings"]).toEqual({ disableClaudeAiConnectors: true });
      expect(seen.options?.["mcpServers"]).toBeUndefined();
    } finally {
      ws.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
