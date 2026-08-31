import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Inference } from "../agent/loop.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Kernel } from "./kernel.js";
import { handleApiRequest } from "./server.js";

const stub: Inference = {
  async generate() {
    return {
      content: [{ type: "text", text: "hi" }],
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0 },
      model: "stub",
    };
  },
};

describe("handleApiRequest", () => {
  let root: string;
  let kernel: Kernel;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-api-"));
    kernel = await Kernel.boot({
      rootDir: root,
      secrets: new SecretsRegistry(),
      inference: stub,
    });
  });

  afterEach(() => {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("returns status", async () => {
    const res = await handleApiRequest(kernel, { method: "GET", path: "/api/status" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ halted: false, queueDepth: 0 });
  });

  it("toggles the kill switch", async () => {
    await handleApiRequest(kernel, { method: "POST", path: "/api/kill", body: { halted: true } });
    expect(kernel.killSwitch.halted).toBe(true);
    const res = await handleApiRequest(kernel, {
      method: "POST",
      path: "/api/kill",
      body: { halted: false },
    });
    expect(res.body).toEqual({ halted: false });
  });

  it("lists and resolves approvals", async () => {
    kernel.approvals.enqueue({ tool: "files.read", args: { path: "x" }, riskTier: "risky" });
    const list = await handleApiRequest(kernel, { method: "GET", path: "/api/approvals" });
    expect(Array.isArray(list.body)).toBe(true);
    expect((list.body as unknown[]).length).toBe(1);
    await handleApiRequest(kernel, { method: "POST", path: "/api/approve", body: { id: 1 } });
    expect(kernel.approvals.pending()).toHaveLength(0);
  });

  it("handles a prompt via /api/message", async () => {
    const res = await handleApiRequest(kernel, {
      method: "POST",
      path: "/api/message",
      body: { text: "hello" },
    });
    expect(res.body).toMatchObject({ reply: "hi", halted: false });
  });

  it("supports memory upsert/delete and cron enable", async () => {
    const put = await handleApiRequest(kernel, {
      method: "POST",
      path: "/api/memory",
      body: { key: "tz", value: "UTC", kind: "preference" },
    });
    expect(put.status).toBe(200);
    expect((put.body as { key: string }).key).toBe("tz");

    const mem = await handleApiRequest(kernel, {
      method: "GET",
      path: "/api/memory",
      url: "/api/memory?limit=50",
    });
    expect(
      ((mem.body as { facts: Array<{ key: string }> }).facts).some(
        (f) => f.key === "tz",
      ),
    ).toBe(true);

    const job = kernel.crons.create({
      name: "t",
      schedule: "0 0 1 1 *",
      type: "actions",
    });
    await handleApiRequest(kernel, {
      method: "POST",
      path: "/api/crons/enable",
      body: { id: job.id, enabled: false },
    });
    expect(kernel.crons.list().find((j) => j.id === job.id)?.enabled).toBe(
      false,
    );

    kernel.manifest.createProject({ name: "P", type: "x" });
    const st = await handleApiRequest(kernel, {
      method: "POST",
      path: "/api/projects/status",
      body: { slug: "p", status: "dormant" },
    });
    expect((st.body as { status: string }).status).toBe("dormant");
  });

  it("exposes health, clear, and custom sessionId", async () => {
    const health = await handleApiRequest(
      kernel,
      { method: "GET", path: "/api/health" },
      { meta: { discord: true, pid: 42 } },
    );
    expect(health.body).toMatchObject({ ok: true, discord: true, pid: 42 });

    await handleApiRequest(kernel, {
      method: "POST",
      path: "/api/message",
      body: { text: "remember me", sessionId: "primary:owner" },
    });
    const cleared = await handleApiRequest(kernel, {
      method: "POST",
      path: "/api/clear",
      body: { sessionId: "primary:owner" },
    });
    expect(cleared.body).toMatchObject({ cleared: "primary:owner" });
    expect(kernel.sessions.get("primary:owner")).toEqual([]);
  });

  it("exposes projects, crons, activity, failed", async () => {
    kernel.manifest.createProject({ name: "Budget", type: "budget" });
    kernel.crons.create({ name: "j", schedule: "0 0 1 1 *", type: "actions" });
    for (const p of ["/api/projects", "/api/crons", "/api/activity", "/api/failed"]) {
      const res = await handleApiRequest(kernel, { method: "GET", path: p });
      expect(res.status).toBe(200);
    }
  });

  it("validates and 404s", async () => {
    expect((await handleApiRequest(kernel, { method: "POST", path: "/api/message", body: {} })).status).toBe(400);
    expect((await handleApiRequest(kernel, { method: "GET", path: "/nope" })).status).toBe(404);
  });

  it("serves page specs with display data and enforces token on mutations", async () => {
    const project = kernel.manifest.createProject({ name: "Demo", type: "tracker" });
    kernel.pages.write(project.slug, {
      id: "overview",
      title: "Overview",
      widgets: [{ type: "stat", label: "N", query: "SELECT 1 AS n" }],
    });
    const page = await handleApiRequest(kernel, {
      method: "GET",
      path: "/api/pages/overview",
    });
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({
      spec: { id: "overview" },
      data: { 0: [{ n: 1 }] },
    });

    const denied = await handleApiRequest(
      kernel,
      { method: "POST", path: "/api/kill", body: { halted: true } },
      { token: "secret" },
    );
    expect(denied.status).toBe(401);

    const allowed = await handleApiRequest(
      kernel,
      {
        method: "POST",
        path: "/api/kill",
        body: { halted: true },
        headers: { authorization: "Bearer secret" },
      },
      { token: "secret" },
    );
    expect(allowed.status).toBe(200);
    expect(kernel.killSwitch.halted).toBe(true);
  });

  it("reports per-widget query errors instead of empty data", async () => {
    const project = kernel.manifest.createProject({ name: "Broken", type: "x" });
    kernel.pages.write(project.slug, {
      id: "broken",
      title: "Broken",
      widgets: [
        { type: "stat", label: "N", query: "SELECT 1 AS n" },
        { type: "table", query: "SELECT * FROM no_such_table" },
      ],
    });
    const page = await handleApiRequest(kernel, {
      method: "GET",
      path: "/api/pages/broken",
    });
    const body = page.body as {
      data: Record<number, unknown[]>;
      errors: Record<number, string>;
    };
    expect(body.data[0]).toEqual([{ n: 1 }]);
    expect(body.errors[0]).toBeUndefined();
    expect(body.data[1]).toEqual([]);
    expect(body.errors[1]).toContain("no_such_table");
  });

  describe("token auth", () => {
    it("applies a configured token to reads as well as writes", async () => {
      for (const path of ["/api/memory", "/api/projects", "/api/activity"]) {
        const denied = await handleApiRequest(
          kernel,
          { method: "GET", path },
          { token: "secret" },
        );
        expect(denied.status).toBe(401);

        const allowed = await handleApiRequest(
          kernel,
          { method: "GET", path, headers: { "x-kos-token": "secret" } },
          { token: "secret" },
        );
        expect(allowed.status).toBe(200);
      }
    });

    it("leaves the no-token loopback case open", async () => {
      const res = await handleApiRequest(kernel, {
        method: "GET",
        path: "/api/memory",
      });
      expect(res.status).toBe(200);
      const write = await handleApiRequest(kernel, {
        method: "POST",
        path: "/api/memory",
        body: { key: "tz", value: "UTC" },
      });
      expect(write.status).toBe(200);
    });
  });

  describe("/api/mutate", () => {
    beforeEach(() => {
      kernel.workspace.db.exec(
        `CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT, done INTEGER DEFAULT 0);
         CREATE TABLE secrets_vault (id INTEGER PRIMARY KEY, token TEXT);
         INSERT INTO secrets_vault (id, token) VALUES (1, 'keep me');`,
      );
      const project = kernel.manifest.createProject({ name: "Tasks", type: "tracker" });
      kernel.pages.write(project.slug, {
        id: "tasks",
        title: "Tasks",
        widgets: [
          { type: "stat", label: "N", query: "SELECT COUNT(*) AS n FROM tasks" },
          {
            type: "form",
            title: "Add",
            mutate: { table: "tasks", columns: ["title"], allow: ["insert"] },
          },
          {
            type: "list",
            query: "SELECT id, title FROM tasks",
            mutate: { table: "tasks", columns: ["done"], allow: ["update", "delete"] },
          },
          { type: "card", query: "SELECT id, title FROM tasks" },
        ],
      });
    });

    const mutate = (body: Record<string, unknown>) =>
      handleApiRequest(kernel, { method: "POST", path: "/api/mutate", body });

    it("resolves the target from the stored spec", async () => {
      const res = await mutate({
        pageId: "tasks",
        widgetIndex: 1,
        op: "insert",
        values: { title: "write tests" },
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ changes: 1 });
      const rows = kernel.workspace.db
        .prepare("SELECT title FROM tasks")
        .all() as Array<{ title: string }>;
      expect(rows).toEqual([{ title: "write tests" }]);
    });

    it("ignores a table and columns supplied by the caller", async () => {
      const res = await mutate({
        pageId: "tasks",
        widgetIndex: 1,
        op: "insert",
        table: "secrets_vault",
        columns: ["token"],
        allow: ["insert", "update", "delete"],
        values: { token: "stolen" },
      });
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toContain("not editable");
      const rows = kernel.workspace.db
        .prepare("SELECT token FROM secrets_vault")
        .all() as Array<{ token: string }>;
      expect(rows).toEqual([{ token: "keep me" }]);
    });

    it("rejects an op the widget did not declare", async () => {
      const res = await mutate({
        pageId: "tasks",
        widgetIndex: 1,
        op: "delete",
        key: { column: "id", value: 1 },
      });
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toContain("op not allowed");
    });

    it("rejects a column the widget did not declare", async () => {
      kernel.workspace.db.prepare("INSERT INTO tasks (title) VALUES ('a')").run();
      const res = await mutate({
        pageId: "tasks",
        widgetIndex: 2,
        op: "update",
        key: { column: "id", value: 1 },
        values: { title: "renamed" },
      });
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toContain("not editable");
    });

    it("rejects an unknown page or widget index", async () => {
      const noPage = await mutate({
        pageId: "nope",
        widgetIndex: 0,
        op: "insert",
        values: { title: "x" },
      });
      expect(noPage.status).toBe(404);

      const noWidget = await mutate({
        pageId: "tasks",
        widgetIndex: 9,
        op: "insert",
        values: { title: "x" },
      });
      expect(noWidget.status).toBe(404);

      const missing = await mutate({ op: "insert", values: { title: "x" } });
      expect(missing.status).toBe(400);
    });

    it("rejects a widget that is not write-capable", async () => {
      const res = await mutate({
        pageId: "tasks",
        widgetIndex: 0,
        op: "insert",
        values: { title: "x" },
      });
      expect(res.status).toBe(403);
      expect((res.body as { error: string }).error).toContain("not write-capable");
    });

    it("rejects a write-capable widget that declares no target", async () => {
      const res = await mutate({
        pageId: "tasks",
        widgetIndex: 3,
        op: "insert",
        values: { title: "x" },
      });
      expect(res.status).toBe(403);
      expect((res.body as { error: string }).error).toContain(
        "no mutation target",
      );
    });

    it("requires a key for update and delete", async () => {
      const res = await mutate({
        pageId: "tasks",
        widgetIndex: 2,
        op: "update",
        values: { done: 1 },
      });
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toContain("key required");
    });
  });

  it("returns the full page when no limit is given", async () => {
    for (let i = 0; i < 5; i++) {
      kernel.facts.upsert("owner", { key: `k${i}`, value: `v${i}`, kind: "fact" });
    }
    // Number(null) is 0 and finite, so an absent limit clamped to one row and
    // these endpoints silently returned a single result.
    const res = await handleApiRequest(kernel, {
      method: "GET",
      path: "/api/memory",
    });
    expect((res.body as { facts: unknown[] }).facts.length).toBe(5);
  });

  it("still honours an explicit limit", async () => {
    for (let i = 0; i < 5; i++) {
      kernel.facts.upsert("owner", { key: `k${i}`, value: `v${i}`, kind: "fact" });
    }
    const res = await handleApiRequest(kernel, {
      method: "GET",
      path: "/api/memory",
      url: "/api/memory?limit=2",
    });
    expect((res.body as { facts: unknown[] }).facts.length).toBe(2);
  });
});
