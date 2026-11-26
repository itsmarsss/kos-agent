import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { ApprovalQueue } from "./approvals.js";
import { AuditLog } from "./audit.js";
import { grandfatherJobConsent } from "./jobconsent.js";
import { PermissionStore } from "./permissions.js";
import { CronStore } from "../cron/store.js";
import type { RiskAssessment } from "../risk/tiers.js";
import { SettingsStore } from "../store/settings.js";

/** Judged as the tools would now: a post anywhere but to the owner is beyond Auto, a sql DELETE asks. */
function judge(tool: string, args: Record<string, unknown>): RiskAssessment {
  if (tool === "notify" && args["to"]) return { tier: "risky", escalated: true, beyondAuto: "messages someone besides you" };
  if (tool === "sql" && /daemons/.test(String(args["sql"]))) return { tier: "risky", escalated: true, neverLearned: true };
  return { tier: "risky", escalated: false };
}

function workspace() {
  const db = new Database(":memory:");
  const crons = new CronStore(db as never);
  const approvals = new ApprovalQueue(db as never);
  return { db, crons, approvals, rules: new PermissionStore(db as never), settings: new SettingsStore(db as never), audit: new AuditLog(db as never) };
}

type W = ReturnType<typeof workspace>;
const run = (w: W): number => grandfatherJobConsent(w.db as never, w.rules, w.settings, w.audit, judge, "owner");

describe("the consent jobs that ran before it was kept keep", () => {
  it("keeps what the owner approved for each job's runs, and nothing a learned yes may not cover", () => {
    const w = workspace();
    const job = w.crons.create({ name: "Digest", schedule: "0 7 * * *", type: "self_prompt", prompt: "post", projectSlug: "school" });
    const asked = (tool: string, args: Record<string, unknown>, scope: string | null, over: { guest?: boolean; reached?: boolean; conversationId?: string; owner?: boolean; attended?: boolean } = {}): number =>
      w.approvals.enqueue({ tool, args, riskTier: "risky", conversationId: over.conversationId ?? `cron:${job.id}`, rule: { tool, scope, project: "school" }, ...(over.guest ? { guest: { project: "school", chat: "room" } } : {}), ...(over.reached ? { reached: true } : {}), ...(over.owner ? { owner: true } : {}), ...(over.attended ? { attended: true } : {}) }).id;
    const fetch = asked("http.fetch", { url: "https://api.example/a" }, "host:api.example");
    const again = asked("http.fetch", { url: "https://api.example/b" }, "host:api.example");
    const skill = asked("skills.run", { name: "board" }, null);
    const post = asked("notify", { to: "discord:channel:42", text: "a" }, "to:discord:channel:42");
    const kernel = asked("sql", { sql: "UPDATE daemons SET args = '[]' WHERE id = 1" }, "table:daemons");
    const gone = asked("sql", { sql: "DELETE FROM school_items" }, "table:school_items");
    const whole = asked("mcp.git.git_push", {}, null);
    const guest = asked("http.fetch", { url: "https://g.example" }, "host:g.example", { guest: true });
    const chat = asked("http.fetch", { url: "https://c.example" }, "host:c.example", { conversationId: "c1:owner" });
    // The owner's own words in the job's thread are not its run.
    const ownerTurn = asked("http.fetch", { url: "https://o.example" }, "host:o.example", { owner: true, attended: true });
    const denied = asked("http.fetch", { url: "https://d.example" }, "host:d.example");
    const byOther = asked("http.fetch", { url: "https://b.example" }, "host:b.example");
    for (const id of [fetch, again, skill, post, kernel, gone, whole, guest, chat, ownerTurn]) w.approvals.approve(id, "owner", { via: "dashboard" });
    w.approvals.approve(byOther, "auto", { via: "auto" });
    w.approvals.deny(denied, "owner", { via: "dashboard" });

    expect(run(w)).toBe(2);
    expect(w.rules.list().map((r) => [r.job, r.tool, r.scope])).toEqual([
      [job.id, "http.fetch", "host:api.example"],
      // A skill once kept as the whole tool is kept by its name.
      [job.id, "skills.run", "skill:board"],
    ]);
  });

  it("keys on the job an ask was raised for, where that was kept", () => {
    const w = workspace();
    const job = w.crons.create({ name: "Digest", schedule: "0 7 * * *", type: "self_prompt", prompt: "post" });
    const id = w.approvals.enqueue({ tool: "http.fetch", args: { url: "https://api.example/a" }, riskTier: "risky", conversationId: "agent:watch", job: job.id, rule: { tool: "http.fetch", scope: "host:api.example", project: null } }).id;
    w.approvals.approve(id, "owner", { via: "dashboard" });
    expect(run(w)).toBe(1);
  });

  it("is done once, so a rule the owner revoked stays revoked", () => {
    const w = workspace();
    const job = w.crons.create({ name: "Digest", schedule: "0 7 * * *", type: "self_prompt", prompt: "post" });
    const id = w.approvals.enqueue({ tool: "http.fetch", args: { url: "https://api.example/a" }, riskTier: "risky", conversationId: `cron:${job.id}`, rule: { tool: "http.fetch", scope: "host:api.example", project: null } }).id;
    w.approvals.approve(id, "owner", { via: "dashboard" });
    expect(run(w)).toBe(1);
    w.rules.revoke(w.rules.list()[0]!.id);
    expect(run(w)).toBe(0);
    expect(w.rules.list()).toEqual([]);
  });

  it("keeps nothing for a job that is gone", () => {
    const w = workspace();
    const job = w.crons.create({ name: "Old", schedule: "0 7 * * *", type: "self_prompt", prompt: "post" });
    const id = w.approvals.enqueue({ tool: "http.fetch", args: { url: "https://api.example/a" }, riskTier: "risky", conversationId: `cron:${job.id}`, rule: { tool: "http.fetch", scope: "host:api.example", project: null } }).id;
    w.approvals.approve(id, "owner", { via: "dashboard" });
    w.crons.delete(job.id);
    expect(run(w)).toBe(0);
  });
});
