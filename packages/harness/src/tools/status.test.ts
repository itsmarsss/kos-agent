import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { CronStore } from "../cron/store.js";
import { allowsTool, guested } from "../kernel/caller.js";
import { ModuleLoader, toolRegistryContext } from "../modules/loader.js";
import { ApprovalQueue } from "../ops/approvals.js";
import { RunsLog } from "../ops/runs.js";
import { SpendStore, type Rates } from "../ops/spend.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Workspace } from "../store/workspace.js";
import { createStatusModule, STATUS_TOOL } from "./status.js";

const HOUR = 60 * 60_000;
const NOW = Date.UTC(2026, 10, 19, 9, 0, 0);

describe("kos.status", () => {
  let root: string;
  let ws: Workspace;
  let registry: ToolRegistry;
  let clock: number;
  let runs: RunsLog;
  let approvals: ApprovalQueue;
  let spend: SpendStore;
  let crons: CronStore;
  let rates: Rates;

  /** A run that started and finished `hoursAgo` back. */
  const run = (kind: string, ref: string | null, status: "ok" | "error" | "skipped", hoursAgo: number, error?: string): void => {
    clock = NOW - hoursAgo * HOUR;
    runs.finish(runs.start(kind, ref), status, error ?? null);
    clock = NOW;
  };

  const status = async (input: Record<string, unknown> = {}) => {
    const res = await registry.execute(STATUS_TOOL, input);
    expect(res.isError).toBe(false);
    return { raw: res.content, json: JSON.parse(res.content) };
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-status-"));
    ws = Workspace.open(root);
    clock = NOW;
    const now = () => clock;
    runs = new RunsLog(ws.db, now);
    approvals = new ApprovalQueue(ws.db, undefined, now);
    spend = new SpendStore(ws.db, now);
    crons = new CronStore(ws.db);
    rates = {};
    registry = new ToolRegistry();
    const ctx = toolRegistryContext(registry, { workspace: ws, db: ws.db, secrets: new SecretsRegistry() });
    await new ModuleLoader(ctx).load([
      createStatusModule({ runs, approvals, spend, rates: () => rates, jobName: (id) => crons.get(id)?.name, now }),
    ]);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("is safe, reachable unattended and by name in an allow-list, and refused to a guest", async () => {
    expect(registry.classify(STATUS_TOOL, {}).tier).toBe("safe");
    expect(allowsTool([STATUS_TOOL], STATUS_TOOL)).toBe(true);
    expect(allowsTool(["kos"], STATUS_TOOL)).toBe(true);
    expect(await registry.refusal(STATUS_TOOL, {})).toBeUndefined();
    const refused = await guested.run({ project: undefined, chat: "discord:room" }, () => registry.refusal(STATUS_TOOL, {}));
    expect(refused).toMatch(/owner's to read/);
  });

  it("counts runs by kind and names each failed job with its first error line", async () => {
    const job = crons.create({ name: "9 AM Daily Kickoff", schedule: "0 9 * * *", type: "self_prompt", prompt: "kick off" });
    run("cron", String(job.id), "ok", 20);
    run("cron", String(job.id), "error", 2, "runs_log: that table is KOS's own\n    at fence (fence.ts:1)");
    run("cron", "999", "error", 3, "gone");
    run("cron", String(job.id), "skipped", 1);
    run("chat", "conversation-1", "ok", 5);
    run("chat", "conversation-1", "error", 4, "the owner's private words");
    const { json } = await status();
    expect(json.runs.kinds).toEqual({ cron: { ok: 1, error: 2 }, chat: { ok: 1, error: 1 } });
    expect(json.runs.cronFailures).toEqual([
      { jobId: job.id, job: "9 AM Daily Kickoff", at: new Date(NOW - 2 * HOUR).toISOString(), error: "runs_log: that table is KOS's own" },
      { jobId: 999, job: null, at: new Date(NOW - 3 * HOUR).toISOString(), error: "gone" },
    ]);
  });

  it("scrubs and caps a failed job's error", async () => {
    const key = `sk-ant-api03-${"x".repeat(40)}`;
    run("cron", "1", "error", 1, `auth failed with ${key} ${"y".repeat(400)}`);
    const { json, raw } = await status();
    const error: string = json.runs.cronFailures[0].error;
    expect(raw).not.toContain(key);
    expect(error.length).toBeLessThanOrEqual(200);
    expect(error.endsWith("…")).toBe(true);
  });

  it("keeps to the window, 24 hours unless said and never past a week", async () => {
    run("chat", "c", "ok", 23);
    run("chat", "c", "ok", 30);
    run("chat", "c", "ok", 200);
    spend.record({ at: NOW - 30 * HOUR, conversationId: "c", task: "reasoning", provider: "anthropic", model: "m", inputTokens: 10, outputTokens: 1 });
    expect((await status()).json.runs.kinds.chat.ok).toBe(1);
    expect((await status()).json.usage.models).toEqual([]);
    const wider = (await status({ hours: 48 })).json;
    expect(wider.window.hours).toBe(48);
    expect(wider.runs.kinds.chat.ok).toBe(2);
    expect(wider.usage.total.inputTokens).toBe(10);
    const capped = (await status({ hours: 1000 })).json;
    expect(capped.window).toEqual({ hours: 168, since: new Date(NOW - 168 * HOUR).toISOString() });
    expect(capped.runs.kinds.chat.ok).toBe(2);
    expect((await registry.execute(STATUS_TOOL, { hours: -1 })).isError).toBe(true);
  });

  it("gives pending approvals as a count and the oldest one's tool and age, never its args", async () => {
    clock = NOW - 90 * 60_000;
    approvals.enqueue({ tool: "shell", args: { command: "rm -rf secret-folder" }, riskTier: "risky", reason: "deletes", conversationId: "c1" });
    clock = NOW - 10 * 60_000;
    approvals.enqueue({ tool: "http.fetch", args: { url: "https://example.com/token=abc" }, riskTier: "risky" });
    clock = NOW;
    const { json, raw } = await status();
    expect(json.approvals).toEqual({ pending: 2, oldest: { tool: "shell", ageMinutes: 90 } });
    expect(raw).not.toContain("secret-folder");
    expect(raw).not.toContain("token=abc");
    expect(raw).not.toContain("c1");
  });

  it("says no approvals are waiting as zero and no oldest", async () => {
    expect((await status()).json.approvals).toEqual({ pending: 0, oldest: null });
  });

  it("prices usage at the owner's rates, leaves an unpriced model's cost null, and totals", async () => {
    rates = { "anthropic:priced": { inputPerMillion: 3, outputPerMillion: 15 } };
    const at = NOW - HOUR;
    spend.record({ at, conversationId: "c", task: "reasoning", provider: "anthropic", model: "priced", inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 500_000 });
    spend.record({ at, conversationId: "c", task: "cheap", provider: "local", model: "free-ish", inputTokens: 2_000, outputTokens: 300 });
    const { json } = await status();
    const priced = json.usage.models.find((m: { model: string }) => m.model === "anthropic:priced");
    // Half fresh at $3, half cache reads at a tenth of it, and the output at $15.
    expect(priced).toEqual({
      model: "anthropic:priced",
      calls: 1,
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 500_000,
      cacheCreationTokens: 0,
      costUSD: 3.15,
    });
    const unpriced = json.usage.models.find((m: { model: string }) => m.model === "local:free-ish");
    expect(unpriced.costUSD).toBeNull();
    expect(unpriced.inputTokens).toBe(2_000);
    expect(json.usage.total).toEqual({
      calls: 2,
      inputTokens: 1_002_000,
      outputTokens: 100_300,
      cacheReadTokens: 500_000,
      cacheCreationTokens: 0,
      costUSD: null,
      unpriced: ["local:free-ish"],
    });
    rates["local:free-ish"] = { inputPerMillion: 0, outputPerMillion: 0 };
    expect((await status()).json.usage.total.costUSD).toBe(3.15);
  });

  it("carries no conversation ids, message text or chat errors", async () => {
    run("chat", "secret-conversation", "error", 1, "the owner said something private");
    spend.record({ at: NOW - HOUR, conversationId: "secret-conversation", task: "reasoning", provider: "p", model: "m", inputTokens: 5, outputTokens: 5 });
    const { raw } = await status();
    expect(raw).not.toContain("secret-conversation");
    expect(raw).not.toContain("private");
  });
});
