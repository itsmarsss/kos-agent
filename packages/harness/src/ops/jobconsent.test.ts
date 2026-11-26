import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { ApprovalQueue } from "./approvals.js";
import { AuditLog } from "./audit.js";
import { grandfatherJobConsent } from "./jobconsent.js";
import { PermissionStore } from "./permissions.js";
import { CronStore } from "../cron/store.js";
import { SettingsStore } from "../store/settings.js";

function workspace(): { db: Database.Database; crons: CronStore; approvals: ApprovalQueue; rules: PermissionStore; settings: SettingsStore; audit: AuditLog } {
  const db = new Database(":memory:");
  const crons = new CronStore(db as never);
  const approvals = new ApprovalQueue(db as never);
  return { db, crons, approvals, rules: new PermissionStore(db as never), settings: new SettingsStore(db as never), audit: new AuditLog(db as never) };
}

describe("the consent jobs that ran before it was kept keep", () => {
  it("keeps what the owner approved for each job's runs, and nothing else", () => {
    const w = workspace();
    const job = w.crons.create({ name: "Digest", schedule: "0 7 * * *", type: "self_prompt", prompt: "post", projectSlug: "school" });
    const asked = (tool: string, args: Record<string, unknown>, rule: { tool: string; scope: string | null; project: string | null }, over: { guest?: boolean; reached?: boolean; conversationId?: string } = {}): number =>
      w.approvals.enqueue({ tool, args, riskTier: "risky", conversationId: over.conversationId ?? `cron:${job.id}`, rule, ...(over.guest ? { guest: { project: "school", chat: "room" } } : {}), ...(over.reached ? { reached: true } : {}) }).id;
    const post = asked("notify", { to: "discord:channel:42", text: "a" }, { tool: "notify", scope: "to:discord:channel:42", project: "school" });
    asked("notify", { to: "discord:channel:42", text: "b" }, { tool: "notify", scope: "to:discord:channel:42", project: "school" });
    const skill = asked("skills.run", { name: "board" }, { tool: "skills.run", scope: null, project: "school" });
    const denied = asked("http.fetch", { url: "https://x.test" }, { tool: "http.fetch", scope: "host:x.test", project: "school" });
    const gone = asked("sql", { sql: "DELETE FROM school_items" }, { tool: "sql", scope: "table:school_items", project: "school" });
    const guest = asked("notify", { to: "channel:9", text: "c" }, { tool: "notify", scope: "to:channel:9", project: "school" }, { guest: true });
    const chat = asked("notify", { to: "channel:8", text: "d" }, { tool: "notify", scope: "to:channel:8", project: "school" }, { conversationId: "c1:owner" });
    for (const id of [post, skill, gone, guest, chat]) w.approvals.approve(id, "owner", { via: "dashboard" });
    w.approvals.deny(denied, "owner", { via: "dashboard" });

    expect(grandfatherJobConsent(w.db as never, w.rules, w.settings, w.audit)).toBe(2);
    expect(w.rules.list().map((r) => [r.job, r.tool, r.scope])).toEqual([
      [job.id, "notify", "to:discord:channel:42"],
      // A skill once kept as the whole tool is kept by its name.
      [job.id, "skills.run", "skill:board"],
    ]);
  });

  it("is done once, so a rule the owner revoked stays revoked", () => {
    const w = workspace();
    const job = w.crons.create({ name: "Digest", schedule: "0 7 * * *", type: "self_prompt", prompt: "post" });
    const id = w.approvals.enqueue({ tool: "notify", args: { to: "channel:42", text: "a" }, riskTier: "risky", conversationId: `cron:${job.id}`, rule: { tool: "notify", scope: "to:channel:42", project: null } }).id;
    w.approvals.approve(id, "owner", { via: "dashboard" });
    expect(grandfatherJobConsent(w.db as never, w.rules, w.settings, w.audit)).toBe(1);
    w.rules.revoke(w.rules.list()[0]!.id);
    expect(grandfatherJobConsent(w.db as never, w.rules, w.settings, w.audit)).toBe(0);
    expect(w.rules.list()).toEqual([]);
  });

  it("keeps nothing for a job that is gone", () => {
    const w = workspace();
    const job = w.crons.create({ name: "Old", schedule: "0 7 * * *", type: "self_prompt", prompt: "post" });
    const id = w.approvals.enqueue({ tool: "notify", args: { to: "channel:42", text: "a" }, riskTier: "risky", conversationId: `cron:${job.id}`, rule: { tool: "notify", scope: "to:channel:42", project: null } }).id;
    w.approvals.approve(id, "owner", { via: "dashboard" });
    w.crons.delete(job.id);
    expect(grandfatherJobConsent(w.db as never, w.rules, w.settings, w.audit)).toBe(0);
  });
});
