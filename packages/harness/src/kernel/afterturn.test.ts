import { describe, expect, it } from "vitest";

import type { Inference } from "../agent/loop.js";
import { AfterTurn, type AfterTurnDeps } from "./afterturn.js";

function deps(over: Partial<AfterTurnDeps> = {}): AfterTurnDeps & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    ownerId: "owner",
    isClosed: () => false,
    runs: { start: (kind) => { log.push(`run:${kind}`); return 1; }, finish: (_id, status, error) => { log.push(`finish:${status}:${error ?? ""}`); } },
    facts: { ingest: async (_u, text, _s, o) => { log.push(`fact:${text}:${(o?.evidence ?? []).join(",")}`); } },
    embedder: { embed: async (texts) => texts.map(() => [0.1, 0.2]) },
    events: { append: (e) => { log.push(`event:${e.role}:${e.text}:${e.projectSlug ?? "-"}`); return log.length; } },
    conversations: {
      get: (id) => ({ id, title: "hello there…", channel: null, projectSlug: id === "project:books" ? "books" : null }),
      rename: (id, title) => { log.push(`rename:${id}:${title}`); },
    },
    inference: { generate: async () => ({ content: [{ type: "text", text: "Greetings chat" }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" }) } as unknown as Inference,
    ...over,
  };
}

describe("after a turn", () => {
  it("remembers the exchange as a fact and as two events, where they happened", async () => {
    const d = deps();
    await new AfterTurn(d).remember("owner", "I like tea", "Noted.", "project:books");
    // The owner's event id rides along as the fact's evidence.
    expect(d.log).toEqual(["event:owner:I like tea:books", "event:agent:Noted.:books", "fact:I like tea:1"]);
  });

  it("logs a failed write as a run rather than failing the turn", async () => {
    const d = deps({ facts: { ingest: async () => { throw new Error("disk full"); } } });
    await expect(new AfterTurn(d).remember("owner", "x", "y")).resolves.toBeUndefined();
    expect(d.log).toContain("run:memory.facts");
    expect(d.log).toContain("finish:error:disk full");
    // The events still went in; one failure does not stop the other.
    expect(d.log.some((l) => l.startsWith("event:"))).toBe(true);
  });

  it("names a conversation nobody has named", async () => {
    const d = deps();
    await new AfterTurn(d).nameIfUnnamed("c1", "hello there", "hi");
    expect(d.log).toEqual(["rename:c1:Greetings chat"]);
  });

  it("leaves a fixed thread, a chosen title, and a closing host alone", async () => {
    const fixed = deps({ conversations: { get: () => ({ id: "orchestrator:owner", title: "KOS", channel: null, projectSlug: null }), rename: () => { throw new Error("must not"); } } });
    await new AfterTurn(fixed).nameIfUnnamed("orchestrator:owner", "x", "y");
    const chosen = deps({ conversations: { get: (id) => ({ id, title: "Taxes 2026", channel: null, projectSlug: null }), rename: () => { throw new Error("must not"); } } });
    await new AfterTurn(chosen).nameIfUnnamed("c2", "something else", "y");
    const closing = deps({ isClosed: () => true });
    await new AfterTurn(closing).nameIfUnnamed("c3", "hello there", "y");
    expect(closing.log).toEqual([]);
  });
});
