import { describe, expect, it } from "vitest";

import type { PendingAction } from "../ops/approvals.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Decisions, type DecisionsDeps } from "./decisions.js";

function pending(over: Partial<PendingAction> = {}): PendingAction {
  return { id: 5, tool: "files.rm", args: JSON.stringify({ path: "projects/books/x.md" }), riskTier: "risky", reason: "r", status: "pending", userId: "owner", conversationId: "c1", requestedAt: 0, decidedAt: null, decidedBy: null, ...over };
}

function deps(action: PendingAction | undefined, awaited: boolean, over: Partial<DecisionsDeps> = {}) {
  const log: string[] = [];
  const d: DecisionsDeps = {
    ownerId: "owner",
    approvals: { get: () => action, isAwaited: () => awaited, approve: (id, by) => { log.push(`approve:${id}:${by}`); }, deny: (id, by) => { log.push(`deny:${id}:${by}`); return action; } },
    permissions: { ruleFor: (tool, _i, project) => ({ tool, scope: "dir:projects/books", project }), add: (r) => { log.push(`rule:${r.tool}:${r.scope}:${r.project}`); } },
    conversations: { get: () => ({ projectSlug: "books" }) },
    audit: { record: (e) => { log.push(`audit:${e.tool}:${e.isError ? "err" : "ok"}`); } },
    registry: { execute: async (tool) => { log.push(`run:${tool}`); return { content: "removed", isError: false }; } },
    secrets: new SecretsRegistry(),
    queue: { enqueue: async (work, lane) => { log.push(`lane:${lane}`); return work(); } },
    inConversation: async (id, work) => { log.push(`in:${id}`); return work(); },
    onToolRan: (tool) => { log.push(`ran:${tool}`); },
    handleMessage: async (text, opts) => { log.push(`resume:${opts.sessionId}:${opts.origin}:${text.includes("approved") ? "approved" : "denied"}`); return { reply: "carried on" }; },
    ...over,
  };
  return { d, log };
}

describe("approving", () => {
  it("releases a waiting turn and does nothing else", async () => {
    const { d, log } = deps(pending(), true);
    const r = await new Decisions(d).approve(5);
    expect(r).toEqual({ ok: true, message: "Approved #5. files.rm is running." });
    expect(log).toEqual(["approve:5:owner"]);
  });

  it("keeps the decision as a rule in the action's project when asked", async () => {
    const { d, log } = deps(pending(), true);
    await new Decisions(d).approve(5, "owner", { remember: true });
    expect(log).toContain("rule:files.rm:dir:projects/books:books");
  });

  it("runs an orphaned action in its conversation and lane, audits it, and resumes the chat", async () => {
    const { d, log } = deps(pending(), false);
    const r = await new Decisions(d).approve(5);
    expect(log).toEqual(["approve:5:owner", "lane:c1", "in:c1", "run:files.rm", "audit:files.rm:ok", "ran:files.rm", "resume:c1:system:approved"]);
    expect(r).toMatchObject({ ok: true, message: "removed", isError: false, reply: "carried on" });
  });

  it("says so when the resume fails rather than swallowing it", async () => {
    const { d } = deps(pending(), false, { handleMessage: async () => { throw new Error("model down"); } });
    const r = await new Decisions(d).approve(5);
    expect(r.reply).toBe("Approved #5 but resume failed: model down");
  });

  it("leaves a build's request to the build itself", async () => {
    const { d, log } = deps(pending({ tool: "build.Bash" }), false);
    const r = await new Decisions(d).approve(5);
    expect(r.message).toBe("Approved. The build continues with Bash.");
    expect(log.some((l) => l.startsWith("run:"))).toBe(false);
    expect(log).toContain("audit:build.Bash:ok");
  });

  it("refuses an action that is not pending", async () => {
    const { d } = deps(undefined, false);
    expect(await new Decisions(d).approve(9)).toEqual({ ok: false, message: "no pending action #9" });
  });
});

describe("denying", () => {
  it("declines a waiting turn in one line", async () => {
    const { d } = deps(pending(), true);
    expect(await new Decisions(d).deny(5)).toEqual({ ok: true, message: "Declined #5." });
  });

  it("tells an orphaned conversation it was refused and lets it ask how to go on", async () => {
    const { d, log } = deps(pending(), false);
    const r = await new Decisions(d).deny(5);
    expect(log).toContain("resume:c1:system:denied");
    expect(r).toMatchObject({ ok: true, message: "denied #5", reply: "carried on" });
  });

  it("tells a build it may not, without a turn", async () => {
    const { d, log } = deps(pending({ tool: "build.Read" }), false);
    const r = await new Decisions(d).deny(5);
    expect(r.message).toBe("Declined. The build was told it may not Read.");
    expect(log.some((l) => l.startsWith("resume:"))).toBe(false);
  });
});
