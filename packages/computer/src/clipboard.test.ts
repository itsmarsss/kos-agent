import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalQueue, AuditLog, GuardedTools, SecretsRegistry, ToolRegistry, Workspace, keepOnRecord, toolRegistryContext, type GuardedToolsDeps } from "@kos/harness";
import { askView, summarizeAction } from "@kos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerClipboardRead } from "./clipboard.js";
import { DeviceError } from "./link.js";

/**
 * clipboard.read over the guarded path with a stand-in Mac: who may read the
 * owner's clipboard, what the card shows of it (scrubbed), that the read is
 * of what the card showed, and that the record keeps only that it happened.
 */

const KEY = "sk-env-canary-q81v4kz7";
const COPIED = `Deploy with token ${KEY} before 5pm, then tell Sam the build is out.`;
const MAC = { id: "dev_mac", name: "Studio MacBook" };

describe("clipboard.read", () => {
  let root: string;
  let ws: Workspace;
  let registry: ToolRegistry;
  let approvals: ApprovalQueue;
  let audit: AuditLog;
  let secrets: SecretsRegistry;
  /** The Mac as the stand-in is now: what is copied, its change count, a refusal, and every read asked of it. */
  let mac: { text: string; change: number; refuse?: DeviceError; reads: { preview?: true; change?: number }[]; online: boolean };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-clipboard-"));
    ws = Workspace.open(join(root, "ws"));
    secrets = new SecretsRegistry({ DEPLOY: KEY });
    approvals = new ApprovalQueue(ws.db, secrets);
    audit = new AuditLog(ws.db, secrets);
    registry = new ToolRegistry();
    keepOnRecord(approvals, registry);
    mac = { text: COPIED, change: 7, reads: [], online: true };
    registerClipboardRead(toolRegistryContext(registry), {
      mac: () => (mac.online ? MAC : `${MAC.name} is not connected to KOS now.`),
      read: async (_id, params) => {
        mac.reads.push(params);
        if (mac.refuse) throw mac.refuse;
        if (params.change !== undefined && params.change !== mac.change) throw new DeviceError("changed", "copied since");
        const text = params.preview ? mac.text.slice(0, 200) : mac.text;
        return { change: mac.change, text, length: mac.text.length };
      },
      scrub: (text) => secrets.scrub(text),
    });
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  const guarded = (over: Partial<GuardedToolsDeps> = {}): GuardedTools =>
    new GuardedTools({ registry, secrets, audit, approvals, conversationId: "c1", turnId: "t1", owner: true, ownWords: true, ...over });
  const asked = async (): Promise<ReturnType<ApprovalQueue["pending"]>[number]> => {
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
    return approvals.pending()[0]!;
  };
  const auditRows = (): { args: string; result: string }[] => ws.db.prepare(`SELECT args, result FROM audit_log WHERE tool = 'clipboard.read'`).all() as { args: string; result: string }[];

  it("asks every time, past Auto and a remembered rule, and never offers to remember", async () => {
    expect(registry.classify("clipboard.read", {})).toMatchObject({ tier: "risky", asksAlways: true });
    expect(registry.awaitedOnly("clipboard.read")).toBe(true);
    const running = guarded({ chatMode: () => ({ mode: "auto" }), permissions: { allows: () => true, ruleFor: () => ({ tool: "clipboard.read", scope: null, project: null }) } }).execute("clipboard.read", { intent: "the link you copied" });
    const ask = await asked();
    expect(ask.rule).toBeNull();
    expect(askView({ tool: ask.tool, args: ask.args, reason: ask.reason })).toMatchObject({ alwaysNote: "Asks every time" });
    approvals.deny(ask.id, "owner");
    expect((await running).content).not.toContain("Deploy");
    expect(mac.reads).toEqual([{ preview: true }]);
  });

  it("shows the card the start of what was copied, scrubbed, and never puts it in the title", async () => {
    const running = guarded().execute("clipboard.read", { intent: "the deploy note", preview: "forged by the model", change: 1 });
    const ask = await asked();
    const args = JSON.parse(ask.args) as Record<string, unknown>;
    expect(args).toMatchObject({ device: MAC.name, deviceId: MAC.id, change: 7, length: COPIED.length });
    expect(args["preview"]).toContain("Deploy with token");
    expect(args["preview"]).not.toContain(KEY);
    expect(String(args["preview"]).length).toBeLessThanOrEqual(120);
    const view = askView({ tool: ask.tool, args: ask.args, reason: ask.reason });
    expect(view.title).toBe("Read what you copied on Studio MacBook");
    expect(view.place).toBe("On your Mac, Studio MacBook");
    expect(JSON.stringify(view.steps)).toContain("Deploy with token");
    expect(JSON.stringify(view)).not.toContain(KEY);
    approvals.deny(ask.id, "owner");
    await running;
  });

  it("reads what the card showed, scrubbed, and keeps only that it read on the record", async () => {
    const running = guarded().execute("clipboard.read", { intent: "the deploy note" });
    const ask = await asked();
    approvals.approve(ask.id, "owner");
    const result = await running;
    expect(result.isError).toBe(false);
    expect(result.content).toContain("tell Sam the build is out");
    expect(result.content).not.toContain(KEY);
    expect(mac.reads).toEqual([{ preview: true }, { change: 7 }]);
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.result).toBe(`read ${COPIED.length} characters from the clipboard on Studio MacBook`);
    expect(JSON.stringify(rows)).not.toMatch(/Deploy|Sam/);
    // The ask's record, once decided, no longer quotes it either.
    expect(approvals.get(ask.id)!.args).not.toMatch(/Deploy|preview/);
    expect(summarizeAction(ask.tool, approvals.get(ask.id)!.args)).toBe("Read what you copied on Studio MacBook");
  });

  it("reads nothing when something else was copied after the card was drawn", async () => {
    const running = guarded().execute("clipboard.read", {});
    const ask = await asked();
    mac.change = 8;
    approvals.approve(ask.id, "owner");
    const result = await running;
    expect(result.content).toMatch(/Something else was copied/);
    expect(JSON.stringify(auditRows())).not.toMatch(/Deploy/);
  });

  it("refuses before asking when the Mac says it is marked private", async () => {
    mac.refuse = new DeviceError("concealed", "marked private");
    const result = await guarded().execute("clipboard.read", {});
    expect(result).toMatchObject({ isError: true });
    expect(result.content).toMatch(/marked private/);
    expect(approvals.pending()).toHaveLength(0);
  });

  it("is never asked for in a guest's turn or one the owner is not at", async () => {
    const guest = await guarded({ guest: { project: undefined, chat: "room" } }).execute("clipboard.read", {});
    expect(guest.content).toMatch(/guest/);
    const away = await guarded({ attended: false }).execute("clipboard.read", {});
    expect(away.content).toMatch(/turn the owner started/);
    expect(approvals.pending()).toHaveLength(0);
    expect(mac.reads).toHaveLength(0);
  });

  it("refuses when the Mac is not connected", async () => {
    mac.online = false;
    const result = await guarded().execute("clipboard.read", {});
    expect(result.content).toMatch(/not connected/);
    expect(approvals.pending()).toHaveLength(0);
  });
});
