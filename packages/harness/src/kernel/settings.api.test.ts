import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Kernel } from "./kernel.js";
import { handleApiRequest } from "./server.js";
import { RETENTION_KEY } from "./session.js";

/**
 * Saving settings from the dashboard.
 *
 * The failure worth guarding is the quiet one: a request that carries nothing
 * usable must not be treated as a request to unset everything. Storing only
 * what a request contained reset the owner's saved retention to the defaults
 * on the next start, and the response still reported the old values because
 * they were still in memory.
 */
describe("saving settings", () => {
  let root: string;
  let kernel: Kernel;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-settings-"));
    kernel = await Kernel.boot({ rootDir: root });
  });

  afterEach(() => {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  });

  const post = (path: string, body: unknown) =>
    handleApiRequest(kernel, { method: "POST", path, body: body as never });
  const get = (path: string) => handleApiRequest(kernel, { method: "GET", path, body: {} as never });

  describe("the catch-up limit", () => {
    it("is 3 hours unless set, offered as 0 to 24", async () => {
      const res = await get("/api/settings/behaviour");
      const body = res.body as { behaviour: { catchUpHours: number }; defaults: { catchUpHours: number }; limits: Record<string, [number, number]> };
      expect(body.behaviour.catchUpHours).toBe(3);
      expect(body.defaults.catchUpHours).toBe(3);
      expect(body.limits["catchUpHours"]).toEqual([0, 24]);
    });

    it("keeps what is saved, clamped to its range, and 0 as never", async () => {
      await post("/api/settings/behaviour", { behaviour: { catchUpHours: 99 } });
      expect(kernel.behaviour().catchUpHours).toBe(24);
      await post("/api/settings/behaviour", { behaviour: { catchUpHours: 0 } });
      expect(kernel.behaviour().catchUpHours).toBe(0);
      await post("/api/settings/behaviour", { behaviour: { catchUpHours: 6 } });
      expect(kernel.behaviour().catchUpHours).toBe(6);
    });
  });

  describe("retention", () => {
    it("saves what it is given", async () => {
      const res = await post("/api/settings/retention", {
        maxChars: 64_000,
        maxExchanges: 20,
      });
      expect(res.status).toBe(200);
      expect(kernel.sessions.retention().maxChars).toBe(64_000);
      expect(kernel.sessions.retention().maxExchanges).toBe(20);
    });

    it("keeps the values a later request did not mention", async () => {
      await post("/api/settings/retention", { maxChars: 64_000, maxExchanges: 20 });
      await post("/api/settings/retention", { maxExchanges: 30 });
      const stored = kernel.settings.get<Record<string, number>>(RETENTION_KEY);
      expect(stored?.maxChars).toBe(64_000);
      expect(stored?.maxExchanges).toBe(30);
    });

    it("refuses a value that is not a budget, and changes nothing", async () => {
      await post("/api/settings/retention", { maxChars: 64_000 });
      // Negative is not a smaller budget, it is a typo.
      for (const bad of [{ maxChars: -5 }, { maxExchanges: "abc" }]) {
        const res = await post("/api/settings/retention", bad);
        expect(res.status, JSON.stringify(bad)).toBe(400);
      }
      expect(
        kernel.settings.get<Record<string, number>>(RETENTION_KEY)?.maxChars,
      ).toBe(64_000);
      expect(kernel.sessions.retention().maxChars).toBe(64_000);
    });

    it("turns trimming off as a switch, and keeps the budgets", async () => {
      await post("/api/settings/retention", { maxChars: 64_000 });
      const res = await post("/api/settings/retention", { autoTrim: false });
      expect(res.status).toBe(200);
      const now = kernel.sessions.retention();
      expect(now.autoTrim).toBe(false);
      // Off and back on should not mean remembering what the numbers were.
      expect(now.maxChars).toBe(64_000);
      await post("/api/settings/retention", { autoTrim: true });
      expect(kernel.sessions.retention().autoTrim).toBe(true);
    });

    it("takes zero as off, because that is a thing an owner can mean", async () => {
      const res = await post("/api/settings/retention", {
        maxChars: 0,
        maxExchanges: 0,
        maxToolResultChars: 0,
      });
      expect(res.status).toBe(200);
      expect(kernel.sessions.retention()).toEqual({
        maxChars: 0,
        maxExchanges: 0,
        maxToolResultChars: 0,
        autoTrim: true,
      });
    });
  });

  describe("profile", () => {
    it("saves a name and timezone", async () => {
      const res = await post("/api/settings/profile", {
        name: "Kenny",
        timezone: "America/Toronto",
      });
      expect(res.status).toBe(200);
      expect(kernel.profile.name).toBe("Kenny");
      expect(kernel.profile.timezone).toBe("America/Toronto");
    });

    /*
     * Checked against the runtime rather than a list. A timezone this machine
     * cannot resolve would make every schedule fire at the wrong hour, and
     * nothing would say so.
     */
    it("refuses a timezone this machine does not know", async () => {
      await post("/api/settings/profile", { name: "Kenny", timezone: "UTC" });
      const res = await post("/api/settings/profile", {
        name: "Kenny",
        timezone: "Mars/Olympus",
      });
      expect(res.status).toBe(400);
      expect(kernel.profile.timezone).toBe("UTC");
    });

    it("refuses an empty name rather than storing one", async () => {
      const res = await post("/api/settings/profile", { name: "  " });
      expect(res.status).toBe(400);
    });
  });

  describe("threads that are not the owner's to change", () => {
    /*
     * They were protected by the list not showing them, which protects
     * nothing: the endpoints took any id at all, so the router could be
     * deleted by anyone who guessed its name.
     */
    it("refuses to rename, archive or delete the router", async () => {
      for (const [path, body] of [
        ["/api/conversations/rename", { id: "orchestrator:owner", title: "Nope" }],
        ["/api/conversations/archive", { id: "orchestrator:owner" }],
        ["/api/conversations/delete", { id: "orchestrator:owner" }],
      ] as const) {
        const res = await post(path, body);
        expect(res.status, path).toBe(400);
        expect(JSON.stringify(res.body)).toContain("KOS itself");
      }
      expect(kernel.conversations.get("orchestrator:owner")).toBeDefined();
    });

    it("refuses the same for a surface's own stream", async () => {
      kernel.conversations.create({
        id: "discord:owner",
        userId: "owner",
        channel: "discord",
        title: "Discord",
      });
      const res = await post("/api/conversations/delete", { id: "discord:owner" });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain("discord stream");
      expect(kernel.conversations.get("discord:owner")).toBeDefined();
    });

    it("refuses the same for a schedule's thread, which is its run history", async () => {
      const job = kernel.crons.create({ name: "nightly", schedule: "0 3 * * *", type: "actions", actions: [], enabled: true });
      kernel.conversations.create({
        id: `cron:${job.id}`,
        userId: "owner",
        title: "nightly",
      });
      const res = await post("/api/conversations/rename", {
        id: `cron:${job.id}`,
        title: "something else",
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain("schedule");
    });

    it("lets a deleted schedule's thread go: an ordinary chat, listed as one, to archive or delete", async () => {
      kernel.conversations.create({ id: "cron:22", userId: "owner", title: "School Weekly Plan" });
      const listed = (await get("/api/conversations")).body as { id: string; kind: string }[];
      expect(listed.find((c) => c.id === "cron:22")?.kind).toBe("chat");
      expect((await post("/api/conversations/archive", { id: "cron:22" })).status).toBe(200);
      expect((await post("/api/conversations/delete", { id: "cron:22" })).status).toBe(200);
      expect(kernel.conversations.get("cron:22")).toBeUndefined();
    });

    it("still lets the owner do as they like with their own chats", async () => {
      const mine = kernel.conversations.create({ userId: "owner", title: "Mine" });
      expect((await post("/api/conversations/rename", { id: mine.id, title: "Ours" })).status).toBe(200);
      expect((await post("/api/conversations/archive", { id: mine.id })).status).toBe(200);
      expect((await post("/api/conversations/delete", { id: mine.id })).status).toBe(200);
    });
  });

  describe("deleting a schedule", () => {
    it("takes its thread with it, leaving no orphan", async () => {
      /*
       * The thread holds that job's runs and cannot be renamed or deleted by
       * hand, so left behind it was something the owner could neither reach
       * from the schedule list nor get rid of.
       */
      const job = kernel.crons.create({
        name: "nightly",
        schedule: "0 3 * * *",
        type: "actions",
        actions: [{ tool: "notify", args: { text: "hi" } }],
        enabled: true,
      });
      await kernel.fireCron(job.id);
      expect(kernel.conversations.get(`cron:${job.id}`)).toBeDefined();

      const res = await post("/api/crons/delete", { id: job.id });
      expect(res.status).toBe(200);
      expect(kernel.crons.get(job.id)).toBeUndefined();
      expect(kernel.conversations.get(`cron:${job.id}`)).toBeUndefined();
      expect(kernel.sessions.get(`cron:${job.id}`)).toEqual([]);
    });

    it("by any other path archives its thread, on the record, and tells the surfaces", async () => {
      const job = kernel.crons.create({ name: "digest", schedule: "0 7 * * *", type: "actions", actions: [], enabled: true });
      kernel.conversations.create({ id: `cron:${job.id}`, userId: "owner", title: "digest" });
      const retired: string[] = [];
      kernel.bus.on("chat:retired", ({ conversationId }) => void retired.push(conversationId));
      // cron.remove deletes through the store alone.
      expect(kernel.crons.delete(job.id)).toBe(true);
      expect(kernel.conversations.get(`cron:${job.id}`)?.archived).toBe(true);
      expect(retired).toEqual([`cron:${job.id}`]);
      expect(kernel.audit.recent(1)[0]).toMatchObject({ tool: "chats.archive", result: "archived digest: its schedule was deleted" });
      expect(kernel.isRetiredSchedule(`cron:${job.id}`)).toBe(true);
    });

    it("archives at boot every thread whose schedule is already gone, once", async () => {
      const live = kernel.crons.create({ name: "kept", schedule: "0 7 * * *", type: "actions", actions: [], enabled: true });
      kernel.conversations.create({ id: `cron:${live.id}`, userId: "owner", title: "kept" });
      kernel.conversations.create({ id: "cron:23", userId: "owner", title: "School Lecture Prep" });
      expect(kernel.retireOrphanThreads()).toEqual(["cron:23"]);
      expect(kernel.conversations.get("cron:23")?.archived).toBe(true);
      expect(kernel.conversations.get(`cron:${live.id}`)?.archived).toBe(false);
      expect(kernel.retireOrphanThreads()).toEqual([]);
    });
  });
});
