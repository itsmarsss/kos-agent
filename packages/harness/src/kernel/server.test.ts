import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Inference } from "../agent/loop.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Kernel, orchestratorId } from "./kernel.js";
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

  it("hands the home page memory and modules in the one payload", async () => {
    kernel.facts.upsert(kernel.profile.ownerId, { key: "city", value: "Toronto", kind: "fact" }, "test");
    const res = await handleApiRequest(kernel, { method: "GET", path: "/api/home" });
    const body = res.body as { memory: { claims: number; unread: number; decisions: number; jobs: { name: string }[] }; modules: { modules: unknown[]; builtins: { name: string }[] } };
    expect(body.memory.claims).toBe(1);
    expect(body.memory.decisions).toBe(0);
    expect(body.memory.jobs.map((j) => j.name).sort()).toEqual(["kos.dream", "kos.memory", "kos.observe"]);
    expect(body.modules.modules).toEqual([]);
    expect(body.modules.builtins.map((b) => b.name)).toContain("tasks");
  });

  it("lists everything waiting on the owner in one inbox", async () => {
    kernel.approvals.enqueue({ tool: "files.read", args: { path: "x" }, riskTier: "risky" });
    const res = await handleApiRequest(kernel, { method: "GET", path: "/api/inbox" });
    const body = res.body as { approvals: unknown[]; decisions: unknown[]; failures: unknown[]; suggestions: unknown[] };
    expect(body.approvals).toHaveLength(1);
    expect(body.decisions).toEqual([]);
    expect(body.failures).toEqual([]);
    expect(body.suggestions).toEqual([]);
  });

  it("carries a suggestion in the inbox, and accepting it opens a chat while dismissing closes it", async () => {
    const a = kernel.suggestions.add("blueprint", "Make the pantry a module", "three pantry-shaped projects", "Promote pantry.");
    const b = kernel.suggestions.add("skill", "A digest skill", "done by hand four times");
    const inbox = await handleApiRequest(kernel, { method: "GET", path: "/api/inbox" });
    expect((inbox.body as { suggestions: { id: number }[] }).suggestions.map((s) => s.id)).toEqual([a.id, b.id]);

    const accepted = await handleApiRequest(kernel, { method: "POST", path: "/api/improvements/resolve", body: { id: a.id, action: "accept" } });
    const convoId = (accepted.body as { conversationId: string }).conversationId;
    expect(convoId).toBeTruthy();
    expect(kernel.conversations.get(convoId)?.title).toBe("Make the pantry a module");
    expect(kernel.suggestions.get(a.id)?.resolvedAt).not.toBeNull();

    await handleApiRequest(kernel, { method: "POST", path: "/api/improvements/resolve", body: { id: b.id, action: "dismiss" } });
    expect(kernel.suggestions.pending()).toEqual([]);

    const bad = await handleApiRequest(kernel, { method: "POST", path: "/api/improvements/resolve", body: { id: a.id, action: "nope" } });
    expect(bad.status).toBe(400);
  });

  it("stands up a project and its orchestrator from the dashboard", async () => {
    const res = await handleApiRequest(kernel, { method: "POST", path: "/api/projects/create", body: { name: "Reading Log", type: "tracker" } });
    expect(res.status).toBe(200);
    const made = res.body as { slug: string; name: string; conversationId: string; conversation: { kind: string; projectSlug: string } };
    expect(made).toMatchObject({ name: "Reading Log" });
    expect(made.conversationId).toBe(`project:${made.slug}`);
    expect(made.conversation).toMatchObject({ kind: "project", projectSlug: made.slug });
    // It is in the manifest and openable.
    expect(kernel.manifest.list().some((p) => p.slug === made.slug)).toBe(true);
  });

  it("makes an instance of a blueprint module from the dashboard", async () => {
    mkdirSync(join(root, "modules", "budget"), { recursive: true });
    writeFileSync(
      join(root, "modules", "budget", "module.json"),
      JSON.stringify({
        name: "budget",
        description: "A budget",
        blueprint: {
          type: "budget",
          schema: [{ op: "create_table", table: "tx", columns: [{ name: "id", type: "INTEGER", primaryKey: true }] }],
          pages: [],
          jobs: [],
        },
      }),
      "utf8",
    );
    const res = await handleApiRequest(kernel, { method: "POST", path: "/api/modules/instantiate", body: { module: "budget", name: "Side biz" } });
    expect(res.status).toBe(200);
    expect((res.body as { project: { slug: string; module: string } }).project).toMatchObject({ slug: "side_biz", module: "budget" });
    const list = await handleApiRequest(kernel, { method: "GET", path: "/api/modules" });
    const mod = (list.body as { modules: { name: string; blueprint?: { instances: { slug: string }[] } }[] }).modules[0];
    expect(mod?.blueprint?.instances).toEqual([{ slug: "side_biz", name: "Side biz", status: "active" }]);
  });

  it("installs a module from a folder, lists where it came from, and removes it", async () => {
    const src = mkdtempSync(join(tmpdir(), "kos-modsrc-"));
    writeFileSync(join(src, "module.json"), JSON.stringify({ name: "weather", description: "Weather", command: "node" }), "utf8");
    const made = await handleApiRequest(kernel, { method: "POST", path: "/api/modules/install", body: { source: src, name: "weather" } });
    expect(made.body).toMatchObject({ installed: "weather", origin: null });
    const list = await handleApiRequest(kernel, { method: "GET", path: "/api/modules" });
    expect((list.body as { modules: { name: string; enabled: boolean; origin: string | null }[] }).modules).toEqual([
      expect.objectContaining({ name: "weather", enabled: false, origin: null }),
    ]);
    const gone = await handleApiRequest(kernel, { method: "POST", path: "/api/modules/remove", body: { name: "weather" } });
    expect(gone.body).toEqual({ removed: "weather" });
    rmSync(src, { recursive: true, force: true });
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

  it("does not send run rows nobody asked for with the activity log", async () => {
    /*
     * /api/activity answered with both tool calls and runs, and the dashboard
     * -- its only caller -- read the tools and dropped the runs, having
     * already fetched them from /api/runs. Every poll therefore ran the runs
     * query twice and serialized one copy for nothing.
     */
    const res = await handleApiRequest(kernel, {
      method: "GET",
      path: "/api/activity",
    });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("tools");
    expect(res.body).not.toHaveProperty("runs");
  });

  it("leaves out results the activity list never shows", async () => {
    /*
     * A tool result is most of this response -- 183KB of 324KB on a real
     * workspace -- and the list renders a summary from args, never the
     * result. A failure keeps its text, because the fix flow reads it
     * straight off the row.
     */
    kernel.audit.record({
      tool: "sql",
      args: { query: "SELECT 1" },
      result: "x".repeat(5000),
      isError: false,
      riskTier: "safe",
      userId: "owner",
    });
    kernel.audit.record({
      tool: "notify",
      args: {},
      result: "the surface refused it",
      isError: true,
      riskTier: "safe",
      userId: "owner",
    });

    const res = await handleApiRequest(kernel, {
      method: "GET",
      path: "/api/activity",
    });
    const tools = (res.body as { tools: { tool: string; result: string }[] })
      .tools;
    expect(tools.find((t) => t.tool === "sql")?.result).toBe("");
    expect(tools.find((t) => t.tool === "notify")?.result).toBe(
      "the surface refused it",
    );
  });

  it("serves one call in full for a reader who opened it", async () => {
    kernel.audit.record({
      tool: "sql",
      args: { query: "SELECT 1" },
      result: "the whole thing",
      isError: false,
      riskTier: "safe",
      userId: "owner",
    });
    const listed = await handleApiRequest(kernel, {
      method: "GET",
      path: "/api/activity",
    });
    const id = (listed.body as { tools: { id: number }[] }).tools[0]!.id;

    const one = await handleApiRequest(kernel, {
      method: "GET",
      path: "/api/activity/call",
      url: `/api/activity/call?id=${id}`,
    });
    expect(one.status).toBe(200);
    expect((one.body as { result: string }).result).toBe("the whole thing");

    const missing = await handleApiRequest(kernel, {
      method: "GET",
      path: "/api/activity/call",
      url: "/api/activity/call?id=999999",
    });
    expect(missing.status).toBe(404);
  });

  it("lists skills and lets the owner switch one off and on", async () => {
    const dir = join(kernel.workspace.root, "skills", "demo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "skill.json"), JSON.stringify({ name: "demo", description: "A demo", kind: "prompt" }), "utf8");
    writeFileSync(join(dir, "SKILL.md"), "do the demo", "utf8");

    const listed = await handleApiRequest(kernel, { method: "GET", path: "/api/skills" });
    expect((listed.body as { skills: { name: string; enabled: boolean }[] }).skills).toEqual([
      expect.objectContaining({ name: "demo", enabled: true }),
    ]);

    const off = await handleApiRequest(kernel, { method: "POST", path: "/api/skills/enable", body: { name: "demo", enabled: false } });
    expect(off.status).toBe(200);
    const after = await handleApiRequest(kernel, { method: "GET", path: "/api/skills" });
    expect((after.body as { skills: { enabled: boolean }[] }).skills[0]!.enabled).toBe(false);

    const unknown = await handleApiRequest(kernel, { method: "POST", path: "/api/skills/enable", body: { name: "nope", enabled: false } });
    expect(unknown.status).toBe(404);
  });

  it("starts a conversation inside a project, and routes a project turn", async () => {
    const project = kernel.manifest.createProject({ name: "Budget", type: "budget" });
    const made = await handleApiRequest(kernel, { method: "POST", path: "/api/conversations/new", body: { title: "Receipts", projectSlug: project.slug } });
    expect((made.body as { projectSlug: string | null }).projectSlug).toBe(project.slug);

    const turn = await handleApiRequest(kernel, { method: "POST", path: "/api/message", body: { text: "hello", sessionId: `project:${project.slug}` } });
    expect(turn.status).toBe(200);
    expect((turn.body as { conversationId: string }).conversationId).toBe(`project:${project.slug}`);
    const listed = await handleApiRequest(kernel, { method: "GET", path: "/api/conversations" });
    const row = (listed.body as { id: string; kind: string; projectSlug: string | null }[]).find((c) => c.id === `project:${project.slug}`);
    expect(row).toMatchObject({ kind: "project", projectSlug: project.slug });
  });

  it("keeps a decision when asked to, and lists and revokes it", async () => {
    const action = kernel.approvals.enqueue({ tool: "files.rm", args: { path: "projects/books/old.md" }, riskTier: "risky", reason: "test" });
    await handleApiRequest(kernel, { method: "POST", path: "/api/approve", body: { id: action.id, remember: true } });
    const listed = await handleApiRequest(kernel, { method: "GET", path: "/api/permissions" });
    const rules = (listed.body as { rules: { id: number; tool: string; scope: string | null; project: string | null }[] }).rules;
    expect(rules).toEqual([expect.objectContaining({ tool: "files.rm", scope: "dir:projects/books", project: null })]);
    expect(kernel.permissions.allows("files.rm", { path: "projects/books/other.md" })).toBe(true);

    const revoked = await handleApiRequest(kernel, { method: "POST", path: "/api/permissions/revoke", body: { id: rules[0]!.id } });
    expect(revoked.status).toBe(200);
    expect(kernel.permissions.allows("files.rm", { path: "projects/books/other.md" })).toBe(false);
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

  describe("health and running a job by hand", () => {
    it("reports well when nothing is broken", async () => {
      const res = await handleApiRequest(kernel, {
        method: "GET",
        path: "/api/health/report",
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, failing: [] });
    });

    it("runs a job now and says what happened", async () => {
      const job = kernel.crons.create({
        name: "check",
        schedule: "0 3 * * *",
        type: "actions",
        actions: [{ tool: "files.read", args: { path: "nope.md" } }],
        enabled: true,
      });
      const res = await handleApiRequest(kernel, {
        method: "POST",
        path: "/api/crons/run",
        body: { id: job.id },
      });
      expect(res.status).toBe(200);
      // It fired, and every action in it errored. Reporting that as a success
      // is how someone checks a broken job and walks away satisfied.
      expect(res.body).toMatchObject({ ok: false });
      expect((res.body as { error: string }).error).toContain("files.read");

      // Firing it by hand goes through the schedule's own path, so the failure
      // it produced is a real one and shows up as such.
      const report = await handleApiRequest(kernel, {
        method: "GET",
        path: "/api/health/report",
      });
      expect(report.body).toMatchObject({ ok: false });

      const status = await handleApiRequest(kernel, {
        method: "GET",
        path: "/api/status",
      });
      expect(status.body).toMatchObject({ unhealthy: 1 });
    });

    it("refuses a job that does not exist", async () => {
      const res = await handleApiRequest(kernel, {
        method: "POST",
        path: "/api/crons/run",
        body: { id: 9999 },
      });
      expect(res.status).toBe(404);
    });

    describe("fired from outside by a hook", () => {
      const hook = (name: string, secret?: string, method = "POST") =>
        handleApiRequest(
          kernel,
          {
            method,
            path: `/api/hooks/${name}`,
            ...(secret ? { headers: { authorization: `Bearer ${secret}` } } : {}),
          },
          { token: "dash", hookSecret: "hook" },
        );

      function job(enabled = true) {
        return kernel.crons.create({
          name: "poke",
          schedule: "0 3 * * *",
          type: "actions",
          actions: [{ tool: "files.read", args: { path: "nope.md" } }],
          enabled,
        });
      }

      it("runs the named job, and answers before the run is done", async () => {
        const made = job();
        const res = await hook("poke", "hook");
        expect(res).toEqual({ status: 202, body: { accepted: "poke" } });
        // The run happened through the schedule's own path, so it is on the
        // job's record and in health, as a 3am run would be.
        await expect.poll(() => kernel.crons.get(made.id)?.lastRunAt ?? null).not.toBeNull();
        await expect.poll(() => kernel.health.failing().length).toBe(1);
      });

      it("takes the hook secret and nothing else", async () => {
        job();
        expect((await hook("poke")).status).toBe(401);
        // The dashboard token is not a hook secret.
        expect((await hook("poke", "dash")).status).toBe(401);
        // And the hook secret opens no other route.
        const list = await handleApiRequest(
          kernel,
          { method: "GET", path: "/api/crons", headers: { authorization: "Bearer hook" } },
          { token: "dash", hookSecret: "hook" },
        );
        expect(list.status).toBe(401);
      });

      it("is off until a secret is set", async () => {
        job();
        const res = await handleApiRequest(kernel, {
          method: "POST",
          path: "/api/hooks/poke",
          headers: { authorization: "Bearer anything" },
        });
        expect(res.status).toBe(403);
      });

      it("will not start a paused job, or one that does not exist", async () => {
        job(false);
        expect((await hook("poke", "hook")).status).toBe(409);
        expect((await hook("other", "hook")).status).toBe(404);
        expect((await hook("poke", "hook", "GET")).status).toBe(405);
      });
    });

    it("forgets a failure the owner has dealt with", async () => {
      kernel.health.observe("cron:1", "check", false, "boom");
      const res = await handleApiRequest(kernel, {
        method: "POST",
        path: "/api/health/dismiss",
        body: { key: "cron:1" },
      });
      expect(res.status).toBe(200);
      expect(kernel.health.report().ok).toBe(true);
    });
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

  it("gives the orchestrator its chats tools from the chat list too", async () => {
    // It is reachable as an ordinary conversation, and it has to be the same
    // agent there as under cmd-K. Two doors, one toolkit.
    const seen: string[][] = [];
    const capture: Inference = {
      async generate(_task, req) {
        seen.push((req.tools ?? []).map((t) => t.name));
        return {
          content: [{ type: "text", text: "ok" }],
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0 },
          model: "stub",
        };
      },
    };
    const dir = mkdtempSync(join(tmpdir(), "kos-orch-"));
    const k = await Kernel.boot({
      rootDir: dir,
      secrets: new SecretsRegistry(),
      inference: capture,
    });
    try {
      await handleApiRequest(k, {
        method: "POST",
        path: "/api/message",
        body: { text: "what is running", sessionId: orchestratorId(k.profile.ownerId) },
      });
      expect(seen.flat()).toContain("chats.list");
    } finally {
      k.close();
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("reports what the extractor has not read, and reads it on request", async () => {
    await handleApiRequest(kernel, { method: "POST", path: "/api/message", body: { text: "my sister Nadia is a nurse in Halifax" } });
    const before = await handleApiRequest(kernel, { method: "GET", path: "/api/memory/extract" });
    // Extraction is on by default now; the threshold is not met by one short
    // message, so nothing has been read automatically and the manual read below
    // is what clears the pending count.
    expect(before.body).toMatchObject({ enabled: true, running: false });
    expect((before.body as { pending: { count: number } }).pending.count).toBeGreaterThan(0);
    // The stub model answers "hi", not JSON: a read that proposes nothing.
    const ran = await handleApiRequest(kernel, { method: "POST", path: "/api/memory/extract" });
    expect(ran.status).toBe(200);
    expect(ran.body).toMatchObject({ proposed: 0, added: 0 });
    expect((ran.body as { events: number }).events).toBeGreaterThan(0);
    const after = await handleApiRequest(kernel, { method: "GET", path: "/api/memory/extract" });
    expect((after.body as { pending: { count: number } }).pending.count).toBe(0);
    expect(kernel.runs.recent().some((r) => r.kind === "memory.extract" && r.status === "ok")).toBe(true);
  });

  describe("a caller with a grant", () => {
    const asCaller = (token: string, method: string, sub: string, body?: unknown) =>
      handleApiRequest(kernel, { method, path: `/api/caller/${sub.split("?")[0]}`, url: `/api/caller/${sub}`, headers: { authorization: `Bearer ${token}` }, ...(body !== undefined ? { body } : {}) }, { token: "dash" });

    it("sees its own scope and only the global tags it was granted", async () => {
      kernel.facts.upsert("owner", { key: "resume_target", value: "staff roles", kind: "fact", tags: ["career"] });
      kernel.facts.upsert("owner", { key: "dentist", value: "Dr Lee", kind: "fact", tags: ["health"] });
      kernel.facts.upsert("owner", { key: "pantry_db", value: "sqlite", kind: "fact", scope: "project:pantry" });
      const { token } = kernel.callers.create("resume-ops", { readTags: ["career"] });
      const seen = await asCaller(token, "GET", "memory");
      expect(seen.status).toBe(200);
      expect(((seen.body as { claims: { key: string }[] }).claims).map((c) => c.key)).toEqual(["resume_target"]);
      // Its own writes land in its scope, marked external, and come back to it; the owner's view keeps them apart.
      const wrote = await asCaller(token, "POST", "memory", { key: "last_posting", value: "Acme staff engineer", tags: ["career"] });
      expect(wrote.body).toMatchObject({ scope: "caller:resume-ops", trust: "external" });
      expect(((await asCaller(token, "GET", "memory")).body as { claims: { key: string }[] }).claims.map((c) => c.key).sort()).toEqual(["last_posting", "resume_target"]);
      // The owner sees it too, in the caller's scope, never as a global claim.
      expect(kernel.facts.get("owner", "last_posting", "global")).toBeUndefined();
      expect(kernel.facts.get("owner", "last_posting")?.scope).toBe("caller:resume-ops");
      // No grant to write global, and no way to forget the owner's claims.
      expect((await asCaller(token, "POST", "memory", { key: "x", value: "y", scope: "global" })).status).toBe(403);
      await asCaller(token, "POST", "memory/delete", { key: "resume_target" });
      expect(kernel.facts.get("owner", "resume_target")?.value).toBe("staff roles");
      expect((await asCaller(token, "GET", "memory/trace?key=dentist")).status).toBe(404);
      expect((await asCaller(token, "GET", "memory/trace?key=resume_target")).status).toBe(200);
    });

    it("takes only its own token, and loses it on revoke", async () => {
      const { caller, token } = kernel.callers.create("tool");
      expect((await asCaller("dash", "GET", "memory")).status).toBe(401);
      expect((await asCaller(token, "GET", "memory")).status).toBe(200);
      // The caller token opens nothing else.
      const other = await handleApiRequest(kernel, { method: "GET", path: "/api/memory", headers: { authorization: `Bearer ${token}` } }, { token: "dash" });
      expect(other.status).toBe(401);
      kernel.callers.revoke(caller.id);
      expect((await asCaller(token, "GET", "memory")).status).toBe(401);
    });

    it("ingests a caller's conversation as the outside world's words, which a reader sees as such", async () => {
      const { token } = kernel.callers.create("notes");
      const res = await asCaller(token, "POST", "ingest", { events: [{ role: "owner", text: "we chose the blue theme", conversation: "c7" }, { role: "agent", text: "noted" }, { text: "" }] });
      expect(res.body).toEqual({ ingested: 2 });
      const hit = kernel.events.search({ userId: "owner", query: "blue theme" })[0]!;
      expect(hit).toMatchObject({ caller: "notes", trust: "external", conversationId: "caller:notes:c7" });
      const read = kernel.events.since("owner", 0).find((e) => e.caller === "notes")!;
      expect(read.trust).toBe("external");
    });

    it("lets the owner make, list and revoke callers, showing the token once", async () => {
      const made = await handleApiRequest(kernel, { method: "POST", path: "/api/callers", body: { name: "resume-ops", readTags: ["career"], writeGlobal: true } });
      expect(made.status).toBe(200);
      expect((made.body as { token: string }).token).toMatch(/^kosc_/);
      const list = await handleApiRequest(kernel, { method: "GET", path: "/api/callers" });
      expect((list.body as { callers: { name: string; writeGlobal: boolean }[] }).callers).toEqual([expect.objectContaining({ name: "resume-ops", writeGlobal: true })]);
      expect(JSON.stringify(list.body)).not.toContain("kosc_");
      expect((await handleApiRequest(kernel, { method: "POST", path: "/api/callers", body: { name: "resume-ops" } })).status).toBe(400);
      const id = (made.body as { caller: { id: number } }).caller.id;
      expect((await handleApiRequest(kernel, { method: "POST", path: "/api/callers/revoke", body: { id } })).body).toEqual({ id, revoked: true });
    });
  });

  it("carries out a review decision and reads page edits back", async () => {
    kernel.facts.upsert("owner", { key: "city", value: "Montreal", kind: "fact" });
    kernel.facts.upsert("owner", { key: "city", value: "Lisbon", kind: "fact", scope: "project:trip" });
    const item = kernel.review.add("contradiction", ["global/city", "project:trip/city"], "which?");
    const bad = await handleApiRequest(kernel, { method: "POST", path: "/api/memory/review/resolve", body: { id: item.id, resolution: "keep first" } });
    expect(bad.status).toBe(400);
    const done = await handleApiRequest(kernel, { method: "POST", path: "/api/memory/review/resolve", body: { id: item.id, action: "keep", key: "global/city" } });
    expect(done.body).toMatchObject({ archived: ["project:trip/city"], promoted: [] });
    expect(kernel.facts.get("owner", "city", "project:trip")).toBeUndefined();
    mkdirSync(kernel.workspace.resolve("memory"), { recursive: true });
    writeFileSync(join(kernel.workspace.resolve("memory"), "profile.md"), "- city: Porto\n");
    const review = await handleApiRequest(kernel, { method: "GET", path: "/api/memory/review" });
    expect((review.body as { edited: string[] }).edited).toEqual(["profile"]);
    const imported = await handleApiRequest(kernel, { method: "POST", path: "/api/memory/pages/import", body: {} });
    expect((imported.body as { imported: { imported: string[] }[] }).imported[0]!.imported).toEqual(["city"]);
    expect(kernel.facts.get("owner", "city")).toMatchObject({ value: "Porto", trust: "owner" });
  });

  it("points classification at the owner's endpoint and back", async () => {
    expect(kernel.classifier.name).toBe("llm");
    const set = await handleApiRequest(kernel, { method: "POST", path: "/api/settings/models/classifier", body: { url: "https://jev.example/classify" } });
    expect(set.body).toEqual({ classifier: { url: "https://jev.example/classify" } });
    expect(kernel.classifier.name).toBe("classifier");
    const shown = await handleApiRequest(kernel, { method: "GET", path: "/api/settings/models" });
    expect((shown.body as { classifier: { url: string } }).classifier).toEqual({ url: "https://jev.example/classify" });
    expect((await handleApiRequest(kernel, { method: "POST", path: "/api/settings/models/classifier", body: { url: "ftp://x" } })).status).toBe(400);
    await handleApiRequest(kernel, { method: "POST", path: "/api/settings/models/classifier", body: { url: "" } });
    expect(kernel.classifier.name).toBe("llm");
  });

  it("switches a built-in feature off and on in place", async () => {
    const before = await handleApiRequest(kernel, { method: "GET", path: "/api/modules" });
    expect((before.body as { builtins: { name: string; enabled: boolean }[] }).builtins).toEqual(expect.arrayContaining([expect.objectContaining({ name: "tasks", enabled: true })]));
    expect(kernel.registry.has("tasks.add")).toBe(true);
    const off = await handleApiRequest(kernel, { method: "POST", path: "/api/modules/enable", body: { name: "tasks", enabled: false } });
    expect(off.body).toEqual({ name: "tasks", enabled: false, builtin: true });
    expect(kernel.registry.has("tasks.add")).toBe(false);
    expect(kernel.registry.has("files.read")).toBe(true);
    await handleApiRequest(kernel, { method: "POST", path: "/api/modules/enable", body: { name: "tasks", enabled: true } });
    expect(kernel.registry.has("tasks.add")).toBe(true);
  });

  it("shows the log, latest first, and by words and meaning when asked", async () => {
    kernel.events.append({ userId: "owner", role: "owner", text: "the garden shed needs a new roof" });
    kernel.events.append({ userId: "owner", role: "agent", text: "noted" });
    const latest = await handleApiRequest(kernel, { method: "GET", path: "/api/memory/log", url: "/api/memory/log?limit=10" });
    expect(((latest.body as { events: { text: string }[] }).events).map((e) => e.text)).toEqual(["noted", "the garden shed needs a new roof"]);
    const found = await handleApiRequest(kernel, { method: "GET", path: "/api/memory/log", url: "/api/memory/log?query=shed%20roof" });
    expect(((found.body as { events: { text: string }[] }).events).map((e) => e.text)).toEqual(["the garden shed needs a new roof"]);
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

describe("owner-written schedules", () => {
  let root: string;
  let kernel: Kernel;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-cronapi-"));
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

  const post = (path: string, body: Record<string, unknown>) =>
    handleApiRequest(kernel, { method: "POST", path, body });

  it("creates a self_prompt job the owner wrote", async () => {
    const res = await post("/api/crons/create", {
      name: "Morning",
      schedule: "0 9 * * *",
      type: "self_prompt",
      prompt: "summarise yesterday",
    });
    expect(res.status).toBe(200);
    expect(kernel.crons.list().some((c) => c.name === "Morning")).toBe(true);
  });

  it("refuses a schedule that is not a schedule", async () => {
    const res = await post("/api/crons/create", {
      name: "Bad",
      schedule: "whenever",
      type: "self_prompt",
      prompt: "x",
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("invalid cron schedule");
  });

  it("refuses a self_prompt with nothing to say", async () => {
    const res = await post("/api/crons/create", {
      name: "Empty",
      schedule: "0 9 * * *",
      type: "self_prompt",
      prompt: "   ",
    });
    expect(res.status).toBe(400);
  });

  it("refuses actions that are not tool calls", async () => {
    // The same shape check the tool does; an owner typing JSON by hand is just
    // as able to get it wrong.
    const res = await post("/api/crons/create", {
      name: "Bad actions",
      schedule: "0 9 * * *",
      type: "actions",
      actions: [{ recipient_name: "notify" }],
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("needs a tool");
  });

  it("will not let an edit slip a write into the query", async () => {
    // A query is the job's variable scope, and an edit is exactly as good a
    // place to put a write as a create.
    const made = await post("/api/crons/create", {
      name: "Q",
      schedule: "0 9 * * *",
      type: "self_prompt",
      prompt: "x",
    });
    const id = (made.body as { id: number }).id;
    const res = await post("/api/crons/update", {
      id,
      name: "Q",
      schedule: "0 9 * * *",
      type: "self_prompt",
      prompt: "x",
      query: "DELETE FROM crons",
    });
    expect(res.status).toBe(400);
  });

  it("updates a job in place and keeps its id", async () => {
    const made = await post("/api/crons/create", {
      name: "Before",
      schedule: "0 9 * * *",
      type: "self_prompt",
      prompt: "x",
    });
    const id = (made.body as { id: number }).id;
    const res = await post("/api/crons/update", {
      id,
      name: "After",
      schedule: "0 10 * * *",
      type: "self_prompt",
      prompt: "y",
    });
    expect(res.status).toBe(200);
    const job = kernel.crons.list().find((c) => c.id === id);
    expect(job?.name).toBe("After");
    expect(job?.schedule).toBe("0 10 * * *");
  });
});
