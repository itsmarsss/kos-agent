import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { ApprovalQueue, keepOnRecord } from "../ops/approvals.js";
import { AuditLog } from "../ops/audit.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Workspace } from "../store/workspace.js";
import { Decisions } from "./decisions.js";
import { GuardedTools } from "./guarded.js";

/**
 * A tool that keeps less on the record than it carried (ToolRisk.audited)
 * and runs only for the turn waiting on it (ToolRisk.awaitedOnly): what its
 * card alone showed never reaches the audit, and leaves the ask's record
 * once it is decided.
 */

const SHOWN = "card-only-canary-5qv";
const READ = "result-canary-8mz";

describe("a call kept less on the record", () => {
  let root: string;
  let ws: Workspace;
  let registry: ToolRegistry;
  let approvals: ApprovalQueue;
  let audit: AuditLog;
  let secrets: SecretsRegistry;
  let ran: number;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-audited-"));
    ws = Workspace.open(join(root, "ws"));
    secrets = new SecretsRegistry();
    approvals = new ApprovalQueue(ws.db, secrets);
    audit = new AuditLog(ws.db, secrets);
    registry = new ToolRegistry();
    ran = 0;
    registry.register(
      { name: "private.read", description: "reads something private", inputSchema: { type: "object", properties: {} } },
      () => {
        ran += 1;
        return READ;
      },
      {
        floor: "risky",
        asksAlways: true,
        detached: "never",
        stamp: (input) => ({ ...input, shown: SHOWN }),
        audited: (input, result) => ({
          args: Object.fromEntries(Object.entries(input).filter(([key]) => key !== "shown")),
          result: result.isError ? result.content : "read it",
        }),
      },
    );
    keepOnRecord(approvals, registry);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  const guarded = (over: Partial<ConstructorParameters<typeof GuardedTools>[0]> = {}): GuardedTools =>
    new GuardedTools({ registry, secrets, audit, approvals, conversationId: "c1", turnId: "t1", owner: true, ownWords: true, ...over });
  const decisions = (): Decisions =>
    new Decisions({
      ownerId: "owner",
      approvals,
      permissions: { add: () => undefined },
      audit,
      registry,
      secrets,
      queue: { enqueue: (work) => work() },
      inConversation: (_id, work) => work(),
      onToolRan: () => undefined,
      handleMessage: async () => ({ reply: "" }),
    });
  const auditRows = (): { args: string; result: string }[] => ws.db.prepare(`SELECT args, result FROM audit_log WHERE tool = 'private.read'`).all() as { args: string; result: string }[];

  it("shows the card what was stamped, then keeps neither it nor the result on the record", async () => {
    const running = guarded().execute("private.read", { intent: "for the owner" });
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
    const ask = approvals.pending()[0]!;
    expect(JSON.parse(ask.args)).toMatchObject({ shown: SHOWN });
    await decisions().approve(ask.id, "owner", { surface: "dashboard" });
    expect((await running).content).toContain(READ);
    expect(JSON.parse(approvals.get(ask.id)!.args)).toEqual({ intent: "for the owner" });
    const [row] = auditRows();
    expect(row!.result).toBe("read it");
    expect(row!.args).not.toContain(SHOWN);
    expect(JSON.stringify(auditRows())).not.toContain(READ);
  });

  it("forgets what the card showed when the ask is denied too", async () => {
    const running = guarded().execute("private.read", {});
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
    const ask = approvals.pending()[0]!;
    await decisions().deny(ask.id, "owner", { surface: "dashboard" });
    await running;
    expect(approvals.get(ask.id)!.args).not.toContain(SHOWN);
    expect(ran).toBe(0);
  });

  it("asks past Auto and a remembered rule", async () => {
    const running = guarded({ chatMode: () => ({ mode: "auto" }), permissions: { allows: () => true, ruleFor: () => ({ tool: "private.read", scope: null, project: null }) } }).execute("private.read", {});
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
    expect(ran).toBe(0);
    await decisions().deny(approvals.pending()[0]!.id, "owner", { surface: "dashboard" });
    await running;
  });

  it("lapses an ask decided after its turn stopped waiting, rather than running it for nobody", async () => {
    await guarded({ waitForApproval: false }).execute("private.read", {});
    const ask = approvals.pending()[0]!;
    const decided = await decisions().approve(ask.id, "owner", { surface: "dashboard" });
    expect(decided.ok).toBe(false);
    expect(approvals.get(ask.id)!.status).toBe("expired");
    expect(approvals.get(ask.id)!.args).not.toContain(SHOWN);
    expect(ran).toBe(0);
  });
});
