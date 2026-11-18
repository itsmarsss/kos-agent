import { describe, expect, it } from "vitest";

import { AfterTurn, type AfterTurnDeps } from "./afterturn.js";

function deps(over: Partial<AfterTurnDeps> = {}): AfterTurnDeps & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    ownerId: "owner",
    runs: { start: (kind) => { log.push(`run:${kind}`); return 1; }, finish: (_id, status, error) => { log.push(`finish:${status}:${error ?? ""}`); } },
    facts: { ingest: async (_u, text, _s, o) => { log.push(`fact:${text}:${(o?.evidence ?? []).join(",")}`); } },
    embedder: { embed: async (texts) => texts.map(() => [0.1, 0.2]) },
    events: { append: (e) => { log.push(`event:${e.role}:${e.text}:${e.projectSlug ?? "-"}`); return log.length; } },
    conversations: {
      get: (id) => ({ projectSlug: id === "project:books" ? "books" : null }),
    },
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
});
