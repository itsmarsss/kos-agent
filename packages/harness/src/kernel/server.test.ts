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
});
