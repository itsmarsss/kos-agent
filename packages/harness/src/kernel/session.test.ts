import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ModelMessage } from "../models/types.js";
import { Workspace } from "../store/workspace.js";
import { SessionStore } from "./session.js";

/** One full exchange: owner turn, a tool round-trip, then the final reply. */
function toolExchange(userText: string, toolName: string): ModelMessage[] {
  return [
    { role: "user", content: [{ type: "text", text: userText }] },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: `tu-${toolName}`, name: toolName, input: {} },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: `tu-${toolName}`,
          content: `{"slug":"budget-2026"}`,
        },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ];
}

describe("SessionStore", () => {
  let root: string;
  let ws: Workspace;
  let sessions: SessionStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-session-"));
    ws = Workspace.open(root);
    sessions = new SessionStore(ws.db);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("starts empty and records a plain turn", () => {
    expect(sessions.get("cli:owner")).toEqual([]);
    sessions.record("cli:owner", [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ]);
    const hist = sessions.get("cli:owner");
    expect(hist).toHaveLength(2);
    expect(hist[0]?.role).toBe("user");
    expect(hist[1]?.role).toBe("assistant");
  });

  it("retains tool calls and their results across turns", () => {
    sessions.record("s", toolExchange("make me a budget", "systems.project_create"));
    const hist = sessions.get("s");
    expect(hist).toHaveLength(4);
    expect(hist[1]?.content[0]?.type).toBe("tool_use");
    expect(hist[2]?.content[0]?.type).toBe("tool_result");
    // The slug the agent just created is still visible on the next turn.
    expect(JSON.stringify(hist)).toContain("budget-2026");
  });

  it("truncates whole exchanges, never orphaning a tool_result", () => {
    const store = new SessionStore(ws.db, { maxChars: 700 });
    let history: ModelMessage[] = [];
    for (let i = 0; i < 6; i++) {
      history = [...history, ...toolExchange(`turn ${i}`, `tool.${i}`)];
      history = store.record("s2", history);
    }
    const hist = store.get("s2");
    expect(hist.length).toBeGreaterThan(0);
    // History must begin with a real owner turn, not a dangling tool_result.
    expect(hist[0]?.role).toBe("user");
    expect(hist[0]?.content[0]?.type).toBe("text");
    // Every tool_result must have its tool_use earlier in the history.
    const useIds = new Set(
      hist.flatMap((m) =>
        m.content.filter((b) => b.type === "tool_use").map((b) => b.id),
      ),
    );
    for (const m of hist) {
      for (const b of m.content) {
        if (b.type === "tool_result") expect(useIds.has(b.toolUseId)).toBe(true);
      }
    }
  });

  it("keeps the latest exchange even when it alone exceeds the budget", () => {
    const store = new SessionStore(ws.db, { maxChars: 10 });
    store.record("s3", toolExchange("big one", "systems.migrate"));
    expect(store.get("s3").length).toBe(4);
  });

  it("caps oversized tool results instead of dropping the block", () => {
    const store = new SessionStore(ws.db, { maxToolResultChars: 20 });
    store.record("s4", [
      { role: "user", content: [{ type: "text", text: "query it" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "sql", input: {} }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "t1", content: "x".repeat(5000) },
        ],
      },
    ]);
    const hist = store.get("s4");
    const result = hist[2]?.content[0];
    expect(result?.type).toBe("tool_result");
    expect((result as { content: string }).content).toContain("[truncated");
    expect((result as { content: string }).content.length).toBeLessThan(200);
  });

  it("clears a session", () => {
    sessions.record("x", [
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "assistant", content: [{ type: "text", text: "b" }] },
    ]);
    sessions.clear("x");
    expect(sessions.get("x")).toEqual([]);
  });
});
