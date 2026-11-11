import { undoneResult } from "./guarded.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Inference } from "../agent/loop.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { DRAWN_KEY, GUEST_TOOLS, Kernel, orchestratorId } from "./kernel.js";
import type { DiscordServices, ServerPlace } from "../tools/discord.js";
import { RATES_KEY } from "../ops/spend.js";
import { cronSessionId } from "./session.js";
import { caller } from "./caller.js";
import { crossSiteWrite, handleApiRequest, mentionsOf, withFrames } from "./server.js";

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
      // No Chrome here, and none on the port: a test never starts one, or reaches the owner's.
      chrome: { port: 1, exists: () => false },
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

  it("hands the home page memory, modules and the standing agents in the one payload", async () => {
    kernel.facts.upsert(kernel.profile.ownerId, { key: "city", value: "Toronto", kind: "fact" }, "test");
    kernel.roles.write({ name: "watch", description: "Keeps an eye on a listing", brief: "Watch it.", memory: "own" });
    const res = await handleApiRequest(kernel, { method: "GET", path: "/api/home" });
    const body = res.body as {
      memory: { claims: number; unread: number; decisions: number; jobs: { name: string }[] };
      modules: { modules: unknown[]; builtins: { name: string }[] };
      standing: { name: string; conversationId: string; thread: { activity: string } }[];
    };
    expect(body.standing.map((a) => a.name)).toEqual(["watch"]);
    expect(body.standing[0]).toMatchObject({ conversationId: "agent:watch", thread: { activity: "idle" } });
    expect(body.memory.claims).toBe(1);
    expect(body.memory.decisions).toBe(0);
    expect(body.memory.jobs.map((j) => j.name).sort()).toEqual(["kos.dream", "kos.memory", "kos.observe"]);
    expect(body.modules.modules).toEqual([]);
    expect(body.modules.builtins.map((b) => b.name)).toContain("tasks");
  });

  it("lists a thread as unread until it is opened, and again once it moves", async () => {
    const chat = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Beds" });
    const list = async (): Promise<{ id: string; unread: boolean }[]> =>
      (await handleApiRequest(kernel, { method: "GET", path: "/api/conversations" })).body as never;
    expect((await list()).find((c) => c.id === chat.id)?.unread).toBe(true);

    await handleApiRequest(kernel, { method: "GET", path: `/api/conversations/${encodeURIComponent(chat.id)}/messages` });
    expect((await list()).find((c) => c.id === chat.id)?.unread).toBe(false);

    await new Promise((r) => setTimeout(r, 2));
    kernel.conversations.touch(chat.id);
    expect((await list()).find((c) => c.id === chat.id)?.unread).toBe(true);
  });

  it("marks a chat whose turn threw as errored, until its next turn", async () => {
    let down = true;
    const flaky: Inference = {
      async generate(...args) {
        if (down) throw new Error("model unreachable");
        return stub.generate(...args);
      },
    };
    const root2 = mkdtempSync(join(tmpdir(), "kos-api-err-"));
    const k = await Kernel.boot({ rootDir: root2, secrets: new SecretsRegistry(), inference: flaky });
    try {
      const chat = k.conversations.create({ userId: k.profile.ownerId, title: "Flaky" });
      await expect(k.handleMessage("hi", { sessionId: chat.id, userId: k.profile.ownerId })).rejects.toThrow("model unreachable");
      const list = async (): Promise<{ id: string; activity: string; lastError?: string }[]> =>
        (await handleApiRequest(k, { method: "GET", path: "/api/conversations" })).body as never;
      expect((await list()).find((c) => c.id === chat.id)).toMatchObject({ activity: "error", lastError: "model unreachable" });

      down = false;
      await k.handleMessage("again", { sessionId: chat.id, userId: k.profile.ownerId });
      const after = (await list()).find((c) => c.id === chat.id);
      expect(after?.activity).toBe("idle");
      expect(after?.lastError).toBeUndefined();
    } finally {
      k.close();
      rmSync(root2, { recursive: true, force: true });
    }
  });

  it("gives the home page the shapes its charts draw: runs, hours, a project map and the week by day", async () => {
    kernel.audit.record({ tool: "notify", args: {}, result: "ok", isError: false });
    const garden = kernel.manifest.createProject({ name: "Garden", type: "tracker" });
    kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Beds", projectSlug: garden.slug });
    const res = await handleApiRequest(kernel, { method: "GET", path: "/api/home" });
    const body = res.body as {
      runs: unknown[];
      pulse: { hour: number; calls: number; errors: number }[];
      map: { slug: string; threads: number; working: number; needsYou: number; jobs: number }[];
      upcoming: unknown[];
      spend: { models: unknown[]; byDay: unknown[] };
      chats: { activity: string }[];
    };
    expect(body.runs).toEqual([]);
    expect(body.pulse).toHaveLength(1);
    expect(body.pulse[0]).toMatchObject({ calls: 1, errors: 0 });
    expect(body.map.find((p) => p.slug === garden.slug)).toEqual({ slug: garden.slug, threads: 1, working: 0, needsYou: 0, jobs: 0 });
    expect(body.upcoming).toEqual([]);
    expect(body.spend.byDay).toEqual([]);
    // A chat on the home page says whether it is busy, like the list does.
    expect(body.chats[0]?.activity).toBe("idle");
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

  it("lists skills from a repository folder and servers from the registry, through an injected fetch", async () => {
    const table: Record<string, unknown> = {
      "https://api.github.com/repos/anthropics/skills/contents/skills": [{ name: "pdf", type: "dir" }],
      "https://api.github.com/repos/anthropics/skills": { default_branch: "main" },
      "https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/SKILL.md": "---\nname: pdf\ndescription: Read PDFs.\n---\n",
      "https://registry.modelcontextprotocol.io/v0/servers?limit=30&search=weather": {
        servers: [{ server: { name: "io.github.acme/weather", description: "Weather.", version: "1.0.0", packages: [{ registryType: "npm", identifier: "@acme/weather-mcp", environmentVariables: [{ name: "KEY", isRequired: true, isSecret: true }] }] }, _meta: { "io.modelcontextprotocol.registry/official": { isLatest: true } } }],
      },
    };
    const fetchFn = async (url: string) => {
      const hit = Object.entries(table).find(([k]) => url.startsWith(k))?.[1];
      return { ok: hit !== undefined, status: hit === undefined ? 404 : 200, json: async () => hit, text: async () => String(hit) };
    };
    const skills = await handleApiRequest(kernel, { method: "GET", path: "/api/catalog/skills" }, { fetch: fetchFn });
    expect(skills.body).toMatchObject({
      source: { repo: "anthropics/skills", path: "skills" },
      skills: [{ name: "pdf", description: "Read PDFs.", source: "https://github.com/anthropics/skills/tree/main/skills/pdf", installed: false }],
    });
    expect((await handleApiRequest(kernel, { method: "GET", path: "/api/catalog/skills", url: "/api/catalog/skills?source=nonsense" }, { fetch: fetchFn })).status).toBe(400);

    const picks = await handleApiRequest(kernel, { method: "GET", path: "/api/catalog/mcp" }, { fetch: fetchFn });
    expect((picks.body as { picks: { name: string; installed: boolean }[]; results: unknown[] }).picks.map((p) => p.name)).toContain("filesystem");
    expect((picks.body as { results: unknown[] }).results).toEqual([]);
    const found = await handleApiRequest(kernel, { method: "GET", path: "/api/catalog/mcp", url: "/api/catalog/mcp?q=weather" }, { fetch: fetchFn });
    const results = (found.body as { results: { suggestedName: string; installed: boolean; packages: unknown[] }[] }).results;
    expect(results[0]).toMatchObject({ suggestedName: "weather", installed: false });

    // A pick lands in mcp.json with the workspace filled in; a listing with the answers it asked for.
    const picked = await handleApiRequest(kernel, { method: "POST", path: "/api/mcp/pick", body: { name: "filesystem", enabled: false } });
    expect(picked.body).toMatchObject({ added: ["filesystem"] });
    const listed = await handleApiRequest(kernel, { method: "POST", path: "/api/mcp/catalog", body: { listing: results[0], choice: { package: 0 }, values: { KEY: "k" }, enabled: false } });
    expect(listed.body).toMatchObject({ added: ["weather"] });
    const file = JSON.parse(readFileSync(join(root, "mcp.json"), "utf8")) as { servers: Record<string, { args?: string[]; env?: Record<string, string>; enabled?: boolean }> };
    // The workspace's own root, which is the realpath of the temp dir.
    expect(file.servers["filesystem"]?.args).toEqual(["-y", "@modelcontextprotocol/server-filesystem", kernel.workspace.root]);
    expect(file.servers["weather"]).toMatchObject({ args: ["-y", "@acme/weather-mcp"], env: { KEY: "k" }, enabled: false });
    expect((await handleApiRequest(kernel, { method: "POST", path: "/api/mcp/pick", body: { name: "nope" } })).status).toBe(404);
    // Once added, the listing says so.
    const again = await handleApiRequest(kernel, { method: "GET", path: "/api/catalog/mcp" }, { fetch: fetchFn });
    expect((again.body as { picks: { name: string; installed: boolean }[] }).picks.find((p) => p.name === "filesystem")?.installed).toBe(true);
  });

  it("installs a skill from a folder, off until switched on, and removes it", async () => {
    const src = mkdtempSync(join(tmpdir(), "kos-skillsrc-"));
    writeFileSync(join(src, "SKILL.md"), "---\nname: receipts\ndescription: File receipts.\n---\nSteps.", "utf8");
    const made = await handleApiRequest(kernel, { method: "POST", path: "/api/skills/install", body: { source: src } });
    expect(made.body).toMatchObject({ installed: "receipts", kind: "prompt", origin: null });
    const list = await handleApiRequest(kernel, { method: "GET", path: "/api/skills" });
    expect((list.body as { skills: { name: string; enabled: boolean; origin: string | null }[] }).skills).toEqual([
      expect.objectContaining({ name: "receipts", enabled: false, promoted: false, origin: null }),
    ]);
    expect((await handleApiRequest(kernel, { method: "POST", path: "/api/skills/update", body: { name: "receipts" } })).status).toBe(400);
    const gone = await handleApiRequest(kernel, { method: "POST", path: "/api/skills/remove", body: { name: "receipts" } });
    expect(gone.body).toEqual({ removed: "receipts" });
    expect((await handleApiRequest(kernel, { method: "GET", path: "/api/skills" })).body).toMatchObject({ skills: [] });
    rmSync(src, { recursive: true, force: true });
  });

  it("adds MCP servers to mcp.json from a pasted block, switches and removes them", async () => {
    // Off in the paste, so nothing is spawned for a server that is not there.
    const pasted = JSON.stringify({ mcpServers: { browser: { command: "npx", args: ["@playwright/mcp"], enabled: false } } });
    const added = await handleApiRequest(kernel, { method: "POST", path: "/api/mcp/add", body: { json: pasted } });
    expect(added.body).toMatchObject({ added: ["browser"] });
    const one = await handleApiRequest(kernel, { method: "POST", path: "/api/mcp/add", body: { name: "mail", server: { url: "http://localhost:9/mcp", enabled: false, risk: "safe" } } });
    expect(one.body).toMatchObject({ added: ["mail"] });
    expect((await handleApiRequest(kernel, { method: "POST", path: "/api/mcp/add", body: { json: "{not json" } })).status).toBe(400);
    expect((await handleApiRequest(kernel, { method: "POST", path: "/api/mcp/add", body: { name: "x", server: { enabled: true } } })).status).toBe(400);

    const list = await handleApiRequest(kernel, { method: "GET", path: "/api/mcp" });
    const servers = (list.body as { servers: { name: string; transport: string; command: string; enabled: boolean; risk: string }[] }).servers;
    expect(servers).toEqual([
      expect.objectContaining({ name: "browser", transport: "stdio", command: "npx @playwright/mcp", enabled: false, risk: "risky" }),
      expect.objectContaining({ name: "mail", transport: "http", command: "http://localhost:9/mcp", enabled: false, risk: "safe" }),
    ]);
    expect(JSON.parse(readFileSync(join(root, "mcp.json"), "utf8"))).toHaveProperty("servers.browser.args", ["@playwright/mcp"]);

    expect((await handleApiRequest(kernel, { method: "POST", path: "/api/mcp/enable", body: { name: "zzz", enabled: false } })).status).toBe(404);
    const gone = await handleApiRequest(kernel, { method: "POST", path: "/api/mcp/remove", body: { name: "browser" } });
    expect(gone.body).toEqual({ removed: "browser" });
    expect((await handleApiRequest(kernel, { method: "POST", path: "/api/mcp/remove", body: { name: "browser" } })).status).toBe(404);
    const left = (await handleApiRequest(kernel, { method: "GET", path: "/api/mcp" })).body as { servers: { name: string }[] };
    expect(left.servers.map((s) => s.name)).toEqual(["mail"]);
  });

  it("lists a project with no folder yet as empty, and a wrong path as an error", async () => {
    const project = kernel.manifest.createProject({ name: "Garden", type: "tasks" });
    const list = (path: string) => handleApiRequest(kernel, { method: "GET", path: "/api/files", url: `/api/files?path=${encodeURIComponent(path)}` });
    const empty = await list(`projects/${project.slug}`);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ path: `projects/${project.slug}`, entries: [] });
    expect((await list("projects/nope")).status).toBe(400);
    expect((await list("somewhere/else")).status).toBe(400);
  });

  it("renames, copies, deletes, makes folders and downloads, inside the jail", async () => {
    const project = kernel.manifest.createProject({ name: "Garden", type: "tasks" });
    const dir = `projects/${project.slug}`;
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "a.txt"), "hello");
    const call = (path: string, body: Record<string, unknown>) => handleApiRequest(kernel, { method: "POST", path, body });

    expect((await call("/api/files/mkdir", { path: `${dir}/out` })).body).toEqual({ path: `${dir}/out` });
    expect((await call("/api/files/rename", { from: `${dir}/a.txt`, to: `${dir}/out/b.txt` })).body).toEqual({ path: `${dir}/out/b.txt` });
    expect((await call("/api/files/copy", { from: `${dir}/out/b.txt` })).body).toEqual({ path: `${dir}/out/b copy.txt` });
    expect((await call("/api/files/copy", { from: `${dir}/out`, to: `${dir}/out-2` })).body).toEqual({ path: `${dir}/out-2` });
    expect((await call("/api/files/delete", { path: `${dir}/out-2` })).body).toEqual({ path: `${dir}/out-2` });
    expect(existsSync(join(root, dir, "out-2"))).toBe(false);

    const refused = await call("/api/files/delete", { path: "mcp.json" });
    expect(refused.status).toBe(400);
    expect((await call("/api/files/rename", { from: `${dir}/out/b.txt`, to: "../escape.txt" })).status).toBe(400);
    expect((await call("/api/files/mkdir", { path: `${dir}/out` })).status).toBe(400);

    const dl = await handleApiRequest(kernel, { method: "GET", path: "/api/file/download", url: `/api/file/download?path=${encodeURIComponent(`${dir}/out/b.txt`)}` });
    expect(dl.status).toBe(200);
    expect(dl.headers?.["content-disposition"]).toBe('attachment; filename="b.txt"');
    expect(Buffer.isBuffer(dl.body) && dl.body.toString("utf8")).toBe("hello");
    expect((await handleApiRequest(kernel, { method: "GET", path: "/api/file/download", url: `/api/file/download?path=${encodeURIComponent(dir)}` })).status).toBe(400);
  });

  it("reports the browser view, and has nothing to drive while nothing is attached", async () => {
    const status = await handleApiRequest(kernel, { method: "GET", path: "/api/browser/status" });
    expect(status.body).toMatchObject({ chrome: "stopped", attached: false, tabs: [] });
    // The owner's chrome: nothing to drive without a tab, and no browser to open one in.
    expect((await handleApiRequest(kernel, { method: "POST", path: "/api/browser/navigate", body: { url: "https://x" } })).status).toBe(400);
    expect((await handleApiRequest(kernel, { method: "POST", path: "/api/browser/navigate", body: { tab: "T1" } })).status).toBe(400);
    expect((await handleApiRequest(kernel, { method: "POST", path: "/api/browser/tabs", body: {} })).status).toBe(400);
    expect((await handleApiRequest(kernel, { method: "POST", path: "/api/browser/tabs/close", body: { tab: "T1" } })).status).toBe(400);
  });

  it("tells a pick's setup with the secrets folder beside the settings file, and makes that folder on add", async () => {
    const envPath = join(root, "elsewhere", ".env");
    // No query, so the registry is not asked and no fetch is needed.
    const listed = (await handleApiRequest(kernel, { method: "GET", path: "/api/catalog/mcp" }, { envPath })).body as { picks: { name: string; setup?: string }[] };
    const gmail = listed.picks.find((p) => p.name === "gmail")!;
    expect(gmail.setup).toContain(join(root, "elsewhere", "secrets", "google-oauth-client.json"));
    expect(gmail.setup).not.toContain("{secrets}");
    expect(listed.picks.find((p) => p.name === "filesystem")!.setup).toBeUndefined();
    await handleApiRequest(kernel, { method: "POST", path: "/api/mcp/pick", body: { name: "google-calendar", enabled: false } }, { envPath });
    expect(existsSync(join(root, "elsewhere", "secrets"))).toBe(true);
    const written = (JSON.parse(readFileSync(join(root, "mcp.json"), "utf8")) as { servers: Record<string, { env?: Record<string, string> }> }).servers["google-calendar"]!;
    expect(written.env?.["GOOGLE_OAUTH_CREDENTIALS"]).toBe(join(root, "elsewhere", "secrets", "google-oauth-client.json"));
    await handleApiRequest(kernel, { method: "POST", path: "/api/mcp/remove", body: { name: "google-calendar" } });
  });

  it("keeps a standing agent's thread while its file exists, and lets it go once the agent is removed", async () => {
    kernel.roles.write({ name: "research", description: "Looks things up", brief: "You look.", memory: "own" });
    const thread = kernel.ensureAgentConversation("research");
    const held = await handleApiRequest(kernel, { method: "POST", path: "/api/conversations/delete", body: { id: thread.id } });
    expect(held.status).toBe(400);
    expect((held.body as { error: string }).error).toMatch(/a blob's own thread cannot be deleted/);
    kernel.roles.remove("research");
    const dropped = await handleApiRequest(kernel, { method: "POST", path: "/api/conversations/delete", body: { id: thread.id } });
    expect(dropped.status).toBe(200);
    expect(kernel.conversations.get(thread.id)).toBeUndefined();
  });

  it("keeps KOS's face in the workspace and carries it on the status", async () => {
    expect((await handleApiRequest(kernel, { method: "GET", path: "/api/settings/face" })).body).toEqual({ face: {} });
    let told = 0;
    const off = kernel.bus.on("face:changed", () => void (told += 1));
    const saved = await handleApiRequest(kernel, { method: "POST", path: "/api/settings/face", body: { face: { hue: "400", eyes: "half", gait: 9 } } });
    expect(saved.body).toEqual({ face: { hue: 40, eyes: "half" } });
    // Whatever draws KOS is told, and draws it from what was kept.
    expect(told).toBe(1);
    off();
    expect(kernel.kosDrawing()).toMatchObject({ eyes: "half", shape: { lobes: [] } });
    expect((await handleApiRequest(kernel, { method: "GET", path: "/api/status" })).body).toMatchObject({ face: { hue: 40, eyes: "half" } });
    // An agent's own face rides on its threads, so the list draws it right.
    kernel.roles.write({ name: "research", description: "Looks things up", brief: "You look.", memory: "own", face: { hue: 300 } });
    kernel.ensureAgentConversation("research");
    const listed = (await handleApiRequest(kernel, { method: "GET", path: "/api/conversations" })).body as { id: string; face?: { hue?: number } }[];
    expect(listed.find((c) => c.id === "agent:research")?.face).toEqual({ hue: 300 });
    kernel.roles.remove("research");
  });

  it("keeps the dashboard's theme in the workspace, tells devices of a change and carries it on the status", async () => {
    const get = async (path: string): Promise<unknown> => (await handleApiRequest(kernel, { method: "GET", path })).body;
    expect(await get("/api/settings/theme")).toEqual({ theme: "system", chosen: false });
    expect(await get("/api/status")).not.toHaveProperty("theme");
    const told: string[] = [];
    const off = kernel.bus.on("theme:changed", (e) => void told.push(e.mode));
    const set = (theme: unknown) => handleApiRequest(kernel, { method: "POST", path: "/api/settings/theme", body: { theme } });
    expect((await set("light")).body).toEqual({ theme: "light" });
    // The same choice again is no news to a device.
    await set("light");
    for (const bad of ["dashboard", "blue", 1, undefined]) expect((await set(bad)).status, String(bad)).toBe(400);
    await set("dark");
    off();
    expect(told).toEqual(["light", "dark"]);
    expect(kernel.theme()).toBe("dark");
    // Dark is drawn dark wherever it is, so that is the palette too.
    expect(await get("/api/settings/theme")).toEqual({ theme: "dark", chosen: true, drawn: "dark" });
    expect(await get("/api/status")).toMatchObject({ theme: "dark", drawn: "dark" });
  });

  it("keeps the palette a dashboard reports drawing in, and tells devices only of a change", async () => {
    const get = async (path: string): Promise<unknown> => (await handleApiRequest(kernel, { method: "GET", path })).body;
    const told: unknown[] = [];
    const off = kernel.bus.on("theme:changed", ({ mode, drawn }) => void told.push({ mode, drawn }));
    const report = (drawn: unknown) => handleApiRequest(kernel, { method: "POST", path: "/api/settings/theme/drawn", body: { drawn } });
    const choose = (theme: unknown) => handleApiRequest(kernel, { method: "POST", path: "/api/settings/theme", body: { theme } });
    await choose("system");
    told.length = 0;
    for (const bad of ["system", "dashboard", 1, undefined]) expect((await report(bad)).status, String(bad)).toBe(400);
    expect(told).toEqual([]);
    // A browser forced dark under a light macOS: "system" drawn dark.
    expect((await report("dark")).body).toEqual({ drawn: "dark" });
    await report("dark");
    // Another dashboard, in a light browser, reports later: the latest wins.
    await report("light");
    expect(told).toEqual([{ mode: "system", drawn: "dark" }, { mode: "system", drawn: "light" }]);
    expect(kernel.dashboardTheme()).toEqual({ mode: "system", drawn: "light" });
    expect(await get("/api/status")).toMatchObject({ theme: "system", drawn: "light" });
    expect(await get("/api/settings/theme")).toEqual({ theme: "system", chosen: true, drawn: "light" });
    // Dark is drawn dark wherever it is drawn: told once, with both, before any dashboard reports it.
    told.length = 0;
    await choose("dark");
    expect(told).toEqual([{ mode: "dark", drawn: "dark" }]);
    off();
  });

  it("serves the kept palette after a restart, and reads one kept with a time by an older KOS", async () => {
    kernel.setTheme("system");
    kernel.setDrawnTheme("dark");
    kernel.close();
    kernel = await Kernel.boot({ rootDir: root, secrets: new SecretsRegistry(), inference: stub, chrome: { port: 1, exists: () => false } });
    expect(kernel.dashboardTheme()).toEqual({ mode: "system", drawn: "dark" });
    // An older KOS kept when, and let a report go stale after ten minutes: a year-old one still holds.
    kernel.settings.set(DRAWN_KEY, { drawn: "light", at: Date.now() - 365 * 24 * 60 * 60_000 });
    expect(kernel.dashboardTheme()).toEqual({ mode: "system", drawn: "light" });
    expect((await handleApiRequest(kernel, { method: "GET", path: "/api/status" })).body).toMatchObject({ theme: "system", drawn: "light" });
    // Anything else kept there is no palette.
    kernel.settings.set(DRAWN_KEY, { drawn: "sepia" });
    expect(kernel.dashboardTheme()).toEqual({ mode: "system" });
  });

  it("keeps the palette a dashboard last reported however long none reports, until one reports another", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      const told: unknown[] = [];
      const off = kernel.bus.on("theme:changed", ({ mode, drawn }) => void told.push({ mode, drawn }));
      const status = async (): Promise<unknown> => (await handleApiRequest(kernel, { method: "GET", path: "/api/status" })).body;
      kernel.setTheme("system");
      kernel.setDrawnTheme("dark");
      told.length = 0;
      // Every dashboard closes: a day later, devices still draw its last look, and are told nothing.
      vi.advanceTimersByTime(24 * 60 * 60_000);
      expect(told).toEqual([]);
      expect(kernel.dashboardTheme()).toEqual({ mode: "system", drawn: "dark" });
      expect(await status()).toMatchObject({ theme: "system", drawn: "dark" });
      // The same palette again is no news; another one is.
      kernel.setDrawnTheme("dark");
      kernel.setDrawnTheme("light");
      expect(told).toEqual([{ mode: "system", drawn: "light" }]);
      // A palette chosen outright is kept as the last look, so going back to "system" keeps drawing it.
      told.length = 0;
      kernel.setTheme("dark");
      kernel.setTheme("system");
      expect(told).toEqual([{ mode: "dark", drawn: "dark" }, { mode: "system", drawn: "dark" }]);
      off();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lists, writes, runs and removes standing agents for the Agents page", async () => {
    const empty = (await handleApiRequest(kernel, { method: "GET", path: "/api/agents" })).body as { agents: unknown[]; invalid: unknown[] };
    expect(empty).toEqual({ agents: [], invalid: [] });
    const bad = await handleApiRequest(kernel, { method: "POST", path: "/api/agents/save", body: { name: "Price Watch", description: "x", brief: "y" } });
    expect(bad.status).toBe(400);
    expect((bad.body as { error: string }).error).toMatch(/short and plain/);
    const noPrompt = await handleApiRequest(kernel, { method: "POST", path: "/api/agents/save", body: { name: "price-watch", description: "x", brief: "y", schedule: "0 9 * * 1" } });
    expect((noPrompt.body as { error: string }).error).toMatch(/needs a prompt/);
    const saved = (await handleApiRequest(kernel, {
      method: "POST",
      path: "/api/agents/save",
      body: { name: "price-watch", description: "Watches a listing", brief: "You watch.", tools: "browser, memory", schedule: "0 9 * * 1", prompt: "Look.", task: "cheap" },
    })).body as { agent: { name: string; tools?: string[]; conversationId: string; job?: { id: number; schedule: string; enabled: boolean } } };
    expect(saved.agent).toMatchObject({ name: "price-watch", tools: ["browser", "memory"], conversationId: "agent:price-watch", job: { schedule: "0 9 * * 1", enabled: true } });
    expect(kernel.conversations.get("agent:price-watch")).toMatchObject({ role: "price-watch", toolAllow: ["browser", "memory"] });
    // Making a new one under a name that exists is refused, not an overwrite.
    const dup = await handleApiRequest(kernel, { method: "POST", path: "/api/agents/save", body: { name: "price-watch", description: "Another", brief: "No.", create: true } });
    expect(dup.status).toBe(409);
    expect((dup.body as { error: string }).error).toMatch(/already exists/);
    expect(kernel.roles.get("price-watch")?.description).toBe("Watches a listing");
    const listed = (await handleApiRequest(kernel, { method: "GET", path: "/api/agents" })).body as {
      agents: { name: string; thread: { id: string; activity: string; lastSaid: string | null }; job?: { id: number; nextRunAt: number | null } }[];
    };
    expect(listed.agents.map((a) => a.name)).toEqual(["price-watch"]);
    // What it is up to, and when it runs next, come with the row.
    expect(listed.agents[0]!.thread).toMatchObject({ id: "agent:price-watch", activity: "idle", lastSaid: null });
    // Null here: the scheduler is not running in a test kernel, so there is no next run to name.
    expect(listed.agents[0]!.job!.nextRunAt).toBeNull();
    // A file written by hand has no thread until the list stands one up.
    kernel.roles.write({ name: "byhand", description: "Written in an editor", brief: "You were typed.", memory: "own" });
    expect(kernel.conversations.get("agent:byhand")).toBeUndefined();
    const withHand = (await handleApiRequest(kernel, { method: "GET", path: "/api/agents" })).body as { agents: { name: string }[] };
    expect(withHand.agents.map((a) => a.name)).toEqual(["byhand", "price-watch"]);
    expect(kernel.conversations.get("agent:byhand")).toMatchObject({ role: "byhand", brief: "You were typed." });
    kernel.roles.remove("byhand");
    // Run now fires the agent's job; an agent without one has nothing to run.
    const ran = await handleApiRequest(kernel, { method: "POST", path: "/api/agents/run", body: { name: "price-watch" } });
    expect(ran.status).toBe(200);
    await handleApiRequest(kernel, { method: "POST", path: "/api/agents/save", body: { name: "price-watch", description: "Watches a listing", brief: "You watch." } });
    expect(kernel.crons.list().some((j) => j.agent === "price-watch")).toBe(false);
    expect((await handleApiRequest(kernel, { method: "POST", path: "/api/agents/run", body: { name: "price-watch" } })).status).toBe(400);
    const removed = await handleApiRequest(kernel, { method: "POST", path: "/api/agents/delete", body: { name: "price-watch" } });
    expect(removed.body).toEqual({ removed: "price-watch" });
    expect(kernel.roles.exists("price-watch")).toBe(false);
    expect((await handleApiRequest(kernel, { method: "POST", path: "/api/agents/delete", body: { name: "price-watch" } })).status).toBe(404);
  });

  it("keeps a project's thread while the project lives, and lets it go once the project is deleted", async () => {
    const made = kernel.standUpProject({ name: "Sheds", type: "tracker" });
    const held = await handleApiRequest(kernel, { method: "POST", path: "/api/conversations/delete", body: { id: made.conversationId } });
    expect(held.status).toBe(400);
    expect((held.body as { error: string }).error).toMatch(/a project's own thread cannot be deleted/);
    const gone = (await handleApiRequest(kernel, { method: "POST", path: "/api/projects/delete", body: { slug: made.slug } })).body as { conversationsArchived: number };
    expect(gone.conversationsArchived).toBe(1);
    expect(kernel.conversations.get(made.conversationId)?.archived).toBe(true);
    const dropped = await handleApiRequest(kernel, { method: "POST", path: "/api/conversations/delete", body: { id: made.conversationId } });
    expect(dropped.status).toBe(200);
    expect(kernel.conversations.get(made.conversationId)).toBeUndefined();
  });

  it("hands a chat on from the dashboard, and drafts the brief", async () => {
    const chat = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Beds" });
    const other = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Garden" });
    expect((await handleApiRequest(kernel, { method: "POST", path: "/api/conversations/handoff", body: { from: chat.id, to: other.id } })).status).toBe(400);
    const sent = await handleApiRequest(kernel, { method: "POST", path: "/api/conversations/handoff", body: { from: chat.id, to: `@chat:[${other.id}]`, brief: "Two beds need turning.", ask: "plan it" } });
    expect(sent.body).toMatchObject({ conversationId: other.id, title: "Garden" });
    expect((await handleApiRequest(kernel, { method: "POST", path: "/api/conversations/handoff", body: { from: chat.id, to: "nowhere", brief: "x" } })).status).toBe(400);
    expect((await handleApiRequest(kernel, { method: "POST", path: "/api/conversations/handoff/draft", body: { id: chat.id } })).status).toBe(400);
    await kernel.handleMessage("the beds by the fence", { sessionId: chat.id });
    const draft = (await handleApiRequest(kernel, { method: "POST", path: "/api/conversations/handoff/draft", body: { id: chat.id } })).body as { brief: string };
    expect(draft.brief.length).toBeGreaterThan(0);
  });

  it("carries how iMessage came up on the status, when the host says", async () => {
    const plain = (await handleApiRequest(kernel, { method: "GET", path: "/api/status" })).body as Record<string, unknown>;
    expect(plain).not.toHaveProperty("imessage");
    const told = (await handleApiRequest(kernel, { method: "GET", path: "/api/status" }, { meta: { imessage: { state: "failed", detail: "Full Disk Access is not granted to /n." } } })).body as Record<string, unknown>;
    expect(told["imessage"]).toEqual({ state: "failed", detail: "Full Disk Access is not granted to /n." });
  });

  it("refuses a restart when nothing would start the host again, and says so on the status", async () => {
    const status = (await handleApiRequest(kernel, { method: "GET", path: "/api/status" })).body as { restart: { supported: boolean; pending: boolean; busy: string[] } };
    expect(status.restart).toEqual({ supported: false, pending: false, busy: [] });
    const refused = await handleApiRequest(kernel, { method: "POST", path: "/api/host/restart", body: {} });
    expect(refused.status).toBe(400);
    expect((refused.body as { error: string }).error).toMatch(/restart it by hand/);
    expect((await handleApiRequest(kernel, { method: "POST", path: "/api/host/restart/cancel", body: {} })).body).toMatchObject({ pending: false });
  });

  it("keeps the browser's settings as KOS's own", async () => {
    const none = await handleApiRequest(kernel, { method: "GET", path: "/api/browser/settings" });
    expect(none.body).toMatchObject({ headed: false, chrome: "", extensions: [], search: "https://duckduckgo.com/?q=%s" });
    const bad = await handleApiRequest(kernel, { method: "POST", path: "/api/browser/settings", body: { search: "https://example.com" } });
    expect(bad.status).toBe(400);
    const saved = await handleApiRequest(kernel, {
      method: "POST",
      path: "/api/browser/settings",
      body: { headed: true, chrome: " /opt/chrome ", extensions: ["/x/one", " ", "/x/two"], search: "https://www.google.com/search?q=%s" },
    });
    expect(saved.body).toMatchObject({ headed: true, chrome: "/opt/chrome", extensions: ["/x/one", "/x/two"], search: "https://www.google.com/search?q=%s" });
    expect(kernel.browserConfig()).toMatchObject({ headed: true, chrome: "/opt/chrome", extensions: ["/x/one", "/x/two"] });
    // Cleared fields go back to the defaults.
    const cleared = await handleApiRequest(kernel, { method: "POST", path: "/api/browser/settings", body: { headed: false, chrome: "", extensions: [], search: "" } });
    expect(cleared.body).toMatchObject({ headed: false, chrome: "", extensions: [], search: "https://duckduckgo.com/?q=%s" });
    expect(kernel.browserConfig()).not.toHaveProperty("chrome");
  });

  it("serves the picture an approval was queued with, and nothing for one without", async () => {
    const pictured = kernel.approvals.enqueue({ tool: "browser.act", args: { steps: [{ click: "@e5" }] }, riskTier: "risky", picture: Buffer.from("PIC").toString("base64") });
    const plain = kernel.approvals.enqueue({ tool: "shell", args: { cmd: "ls" }, riskTier: "risky" });
    const list = (await handleApiRequest(kernel, { method: "GET", path: "/api/approvals" })).body as { id: number; picture: boolean; requestedAt: number; expiresAt: number }[];
    expect(list.map((a) => a.picture)).toEqual([true, false]);
    // Each says when it lapses: a day after it was asked, by default.
    expect(list[0]!.expiresAt - list[0]!.requestedAt).toBe(24 * 3_600_000);
    const got = await handleApiRequest(kernel, { method: "GET", path: `/api/approvals/${pictured.id}/picture` });
    expect(got.status).toBe(200);
    expect(got.headers?.["content-type"]).toBe("image/jpeg");
    expect(Buffer.isBuffer(got.body) && got.body.toString("utf8")).toBe("PIC");
    expect((await handleApiRequest(kernel, { method: "GET", path: `/api/approvals/${plain.id}/picture` })).status).toBe(404);
  });

  it("serves a step's frame and puts it on the right transcript card", async () => {
    const conv = kernel.conversations.create({ userId: "owner", title: "Browse", channel: "dashboard" });
    kernel.sessions.set(conv.id, [
      { role: "user", content: [{ type: "text", text: "look" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "browser.visit", input: { url: "https://x" } }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "tu_1", content: "Opened", isError: false }] },
    ]);
    const frame = kernel.frames.add({ conversationId: conv.id, toolUseId: "tu_1", tool: "browser.visit", picture: Buffer.from("PIC").toString("base64") });
    const got = await handleApiRequest(kernel, { method: "GET", path: `/api/frames/${frame.id}` });
    expect(got.status).toBe(200);
    expect(Buffer.isBuffer(got.body) && got.body.toString("utf8")).toBe("PIC");
    expect((await handleApiRequest(kernel, { method: "GET", path: "/api/frames/999" })).status).toBe(404);
    const thread = (await handleApiRequest(kernel, { method: "GET", path: `/api/conversations/${encodeURIComponent(conv.id)}/messages` })).body as { events: { kind: string; frameId?: number }[] };
    const card = thread.events.find((e) => e.kind === "tool");
    expect(card?.frameId).toBe(frame.id);
  });

  it("keeps a step's picture as a frame and tells the turn's surfaces of it", async () => {
    const conv = kernel.conversations.create({ userId: "owner", title: "Screen", channel: "dashboard" });
    kernel.registry.register({ name: "computer.act", description: "c", inputSchema: { type: "object" } }, () => ({ text: "Clicked.", images: [{ mediaType: "image/jpeg", data: "SCREEN" }] }));
    const told: unknown[] = [];
    const off = kernel.progress.subscribe((e) => {
      if (e.kind === "frame") told.push(e);
    });
    const tools = (kernel as unknown as { guardedTools(o: { conversationId: string }): { execute(n: string, i: Record<string, unknown>): Promise<unknown> } }).guardedTools({ conversationId: conv.id });
    await tools.execute("computer.act", { action: "left_click" });
    off();
    const [frame] = kernel.frames.listFor(conv.id);
    expect(frame).toMatchObject({ tool: "computer.act", site: null });
    expect(kernel.frames.pictureOf(frame!.id)).toBe("SCREEN");
    // A screen's frame names no site.
    expect(told).toEqual([{ kind: "frame", conversationId: conv.id, tool: "computer.act", frameId: frame!.id }]);
  });

  it("matches frames without a call id to browser steps in order, skipping steps that never ran", () => {
    const events = [
      { kind: "tool" as const, name: "browser.visit", summary: "", args: {}, result: "Opened" },
      { kind: "tool" as const, name: "sql", summary: "", args: {}, result: "rows" },
      // A step from the old engine, in a transcript from before KOS drove the browser itself.
      { kind: "tool" as const, name: "mcp.browser.agent_browser_click", summary: "", args: {}, result: "not approved (pending #4). no" },
      { kind: "tool" as const, name: "browser.act", summary: "", args: {}, result: undoneResult("denied", "Click Buy") },
      { kind: "tool" as const, name: "browser.act", summary: "", args: {}, result: "Done" },
      { kind: "tool" as const, name: "browser.act", summary: "", args: {}, pendingId: "9" },
    ];
    const frames = [
      { id: 11, toolUseId: null, tool: "browser.visit" },
      { id: 12, toolUseId: null, tool: "browser.act" },
    ];
    expect(withFrames(events, frames).map((e) => (e.kind === "tool" ? e.frameId : null))).toEqual([11, undefined, undefined, undefined, 12, undefined]);
  });

  it("gives any step its picture by the call's id, not only a browser step's", () => {
    const events = [
      { kind: "tool" as const, name: "computer.act", summary: "", args: {}, result: "Clicked", toolUseId: "call_1" },
      { kind: "tool" as const, name: "computer.end", summary: "", args: {}, result: "Ended", toolUseId: "call_2" },
    ];
    const frames = [{ id: 21, toolUseId: "call_1", tool: "computer.act" }];
    expect(withFrames(events, frames).map((e) => (e.kind === "tool" ? e.frameId : null))).toEqual([21, undefined]);
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

  it("sends a step's actions beside the model's account of it, wherever an ask is listed", async () => {
    const args = { intent: "Note: just closing the popup", actions: [{ action: "type", text: "hunter2" }, { action: "key", text: "cmd+q" }] };
    kernel.approvals.enqueue({ tool: "computer.act", args, riskTier: "risky" });
    kernel.approvals.enqueue({ tool: "files.rm", args: { path: "x" }, riskTier: "risky" });
    type Listed = { summary: string; mechanics?: string };
    const lists = [
      (await handleApiRequest(kernel, { method: "GET", path: "/api/approvals" })).body as Listed[],
      ((await handleApiRequest(kernel, { method: "GET", path: "/api/inbox" })).body as { approvals: Listed[] }).approvals,
      ((await handleApiRequest(kernel, { method: "GET", path: "/api/home" })).body as { approvals: Listed[] }).approvals,
    ];
    for (const list of lists) {
      expect(list[0]).toMatchObject({ summary: "Note: just closing the popup", mechanics: "Type “hunter2”, press cmd+q" });
      // Where the summary already is the action, there is nothing beside it.
      expect(list[1]).toMatchObject({ summary: "Delete x" });
      expect(list[1]).not.toHaveProperty("mechanics");
    }
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
    // The name, what it is for and the kind can change; the slug stays.
    const renamed = await handleApiRequest(kernel, { method: "POST", path: "/api/projects/update", body: { slug: "p", name: "Pantry", description: "What is in the cupboard", type: "tracker" } });
    expect(renamed.body).toMatchObject({ slug: "p", name: "Pantry", description: "What is in the cupboard", type: "tracker" });
    expect((await handleApiRequest(kernel, { method: "POST", path: "/api/projects/update", body: { slug: "p", name: "" } })).status).toBe(400);
    expect((await handleApiRequest(kernel, { method: "POST", path: "/api/projects/update", body: { slug: "nope", name: "x" } })).status).toBe(404);
    // A colour of the owner's, kept on the manifest row; null gives it back to the name.
    const painted = await handleApiRequest(kernel, { method: "POST", path: "/api/projects/colour", body: { slug: "p", colour: "#3B82F6" } });
    expect((painted.body as { colour: string | null }).colour).toBe("#3b82f6");
    expect((await handleApiRequest(kernel, { method: "POST", path: "/api/projects/colour", body: { slug: "p", colour: "blue" } })).status).toBe(400);
    const plain = await handleApiRequest(kernel, { method: "POST", path: "/api/projects/colour", body: { slug: "p", colour: null } });
    expect((plain.body as { colour: string | null }).colour).toBeNull();
    expect((await handleApiRequest(kernel, { method: "POST", path: "/api/projects/colour", body: { slug: "nope", colour: null } })).status).toBe(404);
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

  it("says what a job's runs have cost, and that a script job's cost nothing", async () => {
    const thinks = kernel.crons.create({ name: "thinks", schedule: "0 9 * * *", type: "self_prompt", prompt: "think" });
    const script = kernel.crons.create({ name: "script", schedule: "0 9 * * *", type: "actions", actions: [{ tool: "skills.run", args: { name: "board" } }] });
    const fresh = kernel.crons.create({ name: "fresh", schedule: "0 9 * * *", type: "actions" });
    kernel.settings.set(RATES_KEY, { "openai:gpt-5.6-terra": { inputPerMillion: 1, outputPerMillion: 2 } });
    const used = (conversationId: string, inputTokens: number): void =>
      kernel.spend.record({ conversationId, task: "reasoning", provider: "openai", model: "gpt-5.6-terra", inputTokens, outputTokens: 0 });
    // Two runs of the thinking job, the second cheaper; one of the script job with no model call.
    const one = kernel.runs.start("cron", String(thinks.id));
    used(cronSessionId(thinks.id), 2_000_000);
    kernel.runs.finish(one, "ok");
    await new Promise((r) => setTimeout(r, 5));
    const two = kernel.runs.start("cron", String(thinks.id));
    used(cronSessionId(thinks.id), 1_000_000);
    kernel.runs.finish(two, "ok");
    const ran = kernel.runs.start("cron", String(script.id));
    kernel.runs.finish(ran, "ok");
    const jobs = (await handleApiRequest(kernel, { method: "GET", path: "/api/crons" })).body as { id: number; spend?: { runs: number; calls: number; inputTokens: number; cost?: number; last?: { calls: number; cost?: number } } }[];
    expect(jobs.find((j) => j.id === thinks.id)?.spend).toEqual({ runs: 2, calls: 2, inputTokens: 3_000_000, outputTokens: 0, cost: 3, last: { calls: 1, inputTokens: 1_000_000, outputTokens: 0, cost: 1 } });
    expect(jobs.find((j) => j.id === script.id)?.spend).toEqual({ runs: 1, calls: 0, inputTokens: 0, outputTokens: 0, last: { calls: 0, inputTokens: 0, outputTokens: 0 } });
    expect(jobs.find((j) => j.id === fresh.id)?.spend).toBeUndefined();
  });

  it("lists a project's own skills in its detail, with promotion and state", async () => {
    kernel.manifest.createProject({ name: "Books", type: "tracker" });
    const dir = join(root, "skills", "shelf");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "skill.json"), JSON.stringify({ name: "shelf", description: "Counts the shelves.", kind: "script", entry: "run.mjs", projects: ["books"] }), "utf8");
    writeFileSync(join(dir, "run.mjs"), "console.log(1)\n", "utf8");
    const detail = (await handleApiRequest(kernel, { method: "GET", path: "/api/projects/books/detail" })).body as { skills: unknown[] };
    expect(detail.skills).toEqual([{ name: "shelf", kind: "script", description: "Counts the shelves.", file: "skills/shelf/run.mjs", enabled: true, promoted: false }]);
    const other = (await handleApiRequest(kernel, { method: "GET", path: "/api/projects/nowhere/detail" })).status;
    expect(other).toBe(404);
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

    // A slash command in the project's thread is a command there too, not a
    // message for its orchestrator to improvise an answer to.
    const help = await handleApiRequest(kernel, { method: "POST", path: "/api/message", body: { text: "/help", sessionId: `project:${project.slug}` } });
    expect(help.body).toMatchObject({ isCommand: true });
    expect((help.body as { reply: string }).reply).toContain("/agents");
    const agent = await handleApiRequest(kernel, { method: "POST", path: "/api/message", body: { text: "/agent Tiles", sessionId: `project:${project.slug}` } });
    const moved = agent.body as { isCommand: boolean; switchedTo?: string };
    expect(moved.isCommand).toBe(true);
    expect(kernel.conversations.get(moved.switchedTo!)).toMatchObject({ title: "Tiles", projectSlug: project.slug });
  });

  describe("a project's workspace", () => {
    const b64 = (text: string): string => Buffer.from(text).toString("base64");

    it("takes a file into projects/<slug>/ and nowhere else", async () => {
      const project = kernel.manifest.createProject({ name: "Kitchen", type: "tasks" });
      const res = await handleApiRequest(kernel, {
        method: "POST",
        path: `/api/projects/${project.slug}/files`,
        body: { name: "plan.md", mediaType: "text/markdown", data: b64("# Plan") },
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ path: `projects/${project.slug}/plan.md`, size: 6 });
      expect(readFileSync(join(root, "projects", project.slug, "plan.md"), "utf8")).toBe("# Plan");

      // A name that is a path is reduced to its last segment: the write
      // cannot be aimed above the folder or into a sibling.
      const sly = await handleApiRequest(kernel, {
        method: "POST",
        path: `/api/projects/${project.slug}/files`,
        body: { name: "../../sneaky/../out.txt", data: b64("x") },
      });
      expect(sly.body).toEqual({ path: `projects/${project.slug}/out.txt`, size: 1 });
      expect(existsSync(join(root, "projects", project.slug, "out.txt"))).toBe(true);
      expect(existsSync(join(root, "out.txt"))).toBe(false);
      expect(existsSync(join(root, "sneaky"))).toBe(false);

      const nested = await handleApiRequest(kernel, {
        method: "POST",
        path: `/api/projects/${project.slug}/files`,
        body: { name: "photos/cat.png", data: b64("png") },
      });
      expect((nested.body as { path: string }).path).toBe(`projects/${project.slug}/cat.png`);
    });

    it("refuses an oversize file, a nameless one, and an unknown project", async () => {
      const project = kernel.manifest.createProject({ name: "Kitchen", type: "tasks" });
      const big = await handleApiRequest(kernel, {
        method: "POST",
        path: `/api/projects/${project.slug}/files`,
        body: { name: "big.bin", data: "A".repeat(7 * 1024 * 1024) },
      });
      expect(big.status).toBe(400);
      expect((big.body as { error: string }).error).toMatch(/limit is 5MB/);
      expect(existsSync(join(root, "projects", project.slug, "big.bin"))).toBe(false);

      const nameless = await handleApiRequest(kernel, {
        method: "POST",
        path: `/api/projects/${project.slug}/files`,
        body: { name: "..", data: b64("x") },
      });
      expect(nameless.status).toBe(400);

      const missing = await handleApiRequest(kernel, {
        method: "POST",
        path: "/api/projects/nope/files",
        body: { name: "a.txt", data: b64("x") },
      });
      expect(missing.status).toBe(404);
    });

    it("starts an agent under the project and hands it its first task", async () => {
      const project = kernel.manifest.createProject({ name: "Kitchen", type: "tasks" });
      const filed = await handleApiRequest(kernel, {
        method: "POST",
        path: `/api/projects/${project.slug}/agents`,
        body: { title: "Tiles", brief: "You pick tiles." },
      });
      expect(filed.status).toBe(200);
      const agent = filed.body as { id: string; projectSlug: string; title: string; brief: string; kind: string; started: boolean };
      expect(agent).toMatchObject({ projectSlug: project.slug, title: "Tiles", brief: "You pick tiles.", kind: "chat", started: false });
      expect(kernel.conversations.get(agent.id)?.projectSlug).toBe(project.slug);

      const tasked = await handleApiRequest(kernel, {
        method: "POST",
        path: `/api/projects/${project.slug}/agents`,
        body: { title: "Paint", task: "Pick a colour." },
      });
      const worker = tasked.body as { id: string; started: boolean };
      expect(worker.started).toBe(true);
      // Asked as the owner, in the agent's own thread, after the reply went out.
      await vi.waitFor(() => {
        expect(kernel.sessions.get(worker.id).some((m) => m.role === "user")).toBe(true);
      });

      // Untitled, like a new chat: its first message names it.
      const bare = await handleApiRequest(kernel, { method: "POST", path: `/api/projects/${project.slug}/agents`, body: {} });
      expect(bare.status).toBe(200);
      expect(bare.body).toMatchObject({ projectSlug: project.slug, title: "New conversation", started: false });
      expect((await handleApiRequest(kernel, { method: "POST", path: "/api/projects/nope/agents", body: { title: "x" } })).status).toBe(404);
    });

    it("lists the project's agents and files in its detail", async () => {
      const project = kernel.manifest.createProject({ name: "Kitchen", type: "tasks" });
      kernel.ensureProjectConversation(project.slug);
      const agent = kernel.conversations.create({ userId: kernel.profile.ownerId, projectSlug: project.slug, title: "Tiles" });
      kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Unrelated" });
      await handleApiRequest(kernel, {
        method: "POST",
        path: `/api/projects/${project.slug}/files`,
        body: { name: "plan.md", data: b64("# Plan") },
      });

      const res = await handleApiRequest(kernel, { method: "GET", path: `/api/projects/${project.slug}/detail` });
      const detail = res.body as { agents: { id: string; activity: string }[]; files: { name: string; path: string; kind: string; size: number }[] };
      // Its agents and not its orchestrator, which is the project's own chat.
      expect(detail.agents.map((a) => a.id)).toEqual([agent.id]);
      expect(detail.agents[0]?.activity).toBe("idle");
      expect(detail.files).toEqual([
        expect.objectContaining({ name: "plan.md", path: `projects/${project.slug}/plan.md`, kind: "file", size: 6 }),
      ]);

      const bare = kernel.manifest.createProject({ name: "Empty", type: "tasks" });
      const none = await handleApiRequest(kernel, { method: "GET", path: `/api/projects/${bare.slug}/detail` });
      expect((none.body as { agents: unknown[]; files: unknown[] })).toMatchObject({ agents: [], files: [] });
    });
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

    it("says which chat KOS is in when it is already on a failure", async () => {
      kernel.health.observe("cron:1", "check", false, "boom");
      const bare = await handleApiRequest(kernel, { method: "GET", path: "/api/inbox" });
      expect((bare.body as { failures: { fixing?: unknown }[] }).failures[0]?.fixing).toBeUndefined();

      const fix = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Fix: check", projectSlug: "maintenance" });
      const res = await handleApiRequest(kernel, { method: "GET", path: "/api/inbox" });
      const failures = (res.body as { failures: { fixing?: { conversationId: string; activity: string } }[] }).failures;
      expect(failures[0]?.fixing).toEqual({ conversationId: fix.id, activity: "idle" });
      // The home page's What broke panel is told the same.
      const home = await handleApiRequest(kernel, { method: "GET", path: "/api/home" });
      expect((home.body as { health: { failing: { fixing?: { conversationId: string } }[] } }).health.failing[0]?.fixing?.conversationId).toBe(fix.id);
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

    it("lets an extension's open paths answer without the token, and holds the rest behind it", async () => {
      const seen: string[] = [];
      const extensions = [{
        prefix: "/api/devices",
        open: ["/api/devices/pair"],
        handle: (req: { path: string }) => {
          seen.push(req.path);
          return req.path === "/api/devices/none" ? undefined : { status: 200, body: { path: req.path } };
        },
      }];
      expect((await handleApiRequest(kernel, { method: "POST", path: "/api/devices/pair" }, { token: "secret", extensions })).status).toBe(200);
      expect((await handleApiRequest(kernel, { method: "GET", path: "/api/devices" }, { token: "secret", extensions })).status).toBe(401);
      expect(seen).toEqual(["/api/devices/pair"]);
      const owner = { "x-kos-token": "secret" };
      expect((await handleApiRequest(kernel, { method: "GET", path: "/api/devices", headers: owner }, { token: "secret", extensions })).body).toEqual({ path: "/api/devices" });
      expect((await handleApiRequest(kernel, { method: "GET", path: "/api/devices/none", headers: owner }, { token: "secret", extensions })).status).toBe(404);
      // A prefix is a path segment: /api/devicesX is not the extension's.
      expect(seen).not.toContain("/api/devicesX");
      await handleApiRequest(kernel, { method: "GET", path: "/api/devicesX", headers: owner }, { token: "secret", extensions });
      expect(seen).not.toContain("/api/devicesX");
    });

    it("refuses a change another site's page asks for, and lets the dashboard, KOS for Chrome and programs by", async () => {
      kernel.pages.writeHtml(null, { id: "memo", title: "Memo", html: "<p>memo</p>" });
      const post = (headers: Record<string, string>, path = "/api/artifacts/memo/rename") =>
        handleApiRequest(kernel, { method: "POST", path, body: { title: "Taken" }, headers: { host: "127.0.0.1:4317", ...headers } });
      const strangers: Record<string, string>[] = [
        { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
        { origin: "http://127.0.0.1:4422", "sec-fetch-site": "same-site" },
        { origin: "null", "sec-fetch-site": "cross-site" },
        { "sec-fetch-site": "cross-site" },
        { origin: "chrome-extension://not-an-extension" },
      ];
      for (const headers of strangers) {
        const res = await post(headers);
        expect(res.status, JSON.stringify(headers)).toBe(403);
      }
      // Every change, not only an artifact's.
      expect((await post({ origin: "https://evil.example" }, "/api/memory")).status).toBe(403);
      expect(kernel.pages.record("memo")?.title).toBe("Memo");
      // A read is the browser's to keep from another site, by CORS.
      expect((await handleApiRequest(kernel, { method: "GET", path: "/api/artifacts", headers: { host: "127.0.0.1:4317", origin: "https://evil.example" } })).status).toBe(200);
      // The dashboard itself, through a proxy that passes its host on, KOS for Chrome, an allowed origin, and a program that sends no origin.
      expect((await post({ origin: "http://127.0.0.1:4317", "sec-fetch-site": "same-origin" })).status).toBe(200);
      expect((await post({ host: "127.0.0.1:4317", "x-forwarded-host": "kos.example", origin: "https://kos.example" })).status).toBe(200);
      expect((await post({ origin: `chrome-extension://${"a".repeat(32)}`, "sec-fetch-site": "none" })).status).toBe(200);
      expect((await handleApiRequest(kernel, { method: "POST", path: "/api/artifacts/memo/rename", body: { title: "Allowed" }, headers: { host: "127.0.0.1:4317", origin: "https://ok.example" } }, { allowedOrigins: ["https://ok.example"] })).status).toBe(200);
      expect((await post({})).status).toBe(200);
      expect(crossSiteWrite({ method: "POST", path: "/api/x" })).toBe(false);
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

  describe("an HTML page's bridge", () => {
    beforeEach(() => {
      kernel.manifest.createProject({ name: "Shelf", type: "tracker" });
      kernel.manifest.createProject({ name: "Vault", type: "notes" });
      kernel.migrator.migrate("shelf", { op: "create_table", table: "books", columns: [{ name: "id", type: "INTEGER", primaryKey: true }, { name: "title", type: "TEXT" }] });
      kernel.migrator.migrate("vault", { op: "create_table", table: "keys", columns: [{ name: "id", type: "INTEGER", primaryKey: true }, { name: "token", type: "TEXT" }] });
      kernel.workspace.db.exec(
        `INSERT INTO shelf_books (title) VALUES ('Dune');
         INSERT INTO vault_keys (token) VALUES ('keep me');`,
      );
      kernel.pages.writeHtml("shelf", {
        id: "shelf",
        title: "Shelf",
        html: "<p>books</p>",
        capabilities: { writes: [{ table: "shelf_books", columns: ["title"], allow: ["insert"] }] },
        headline: { label: "Books", query: "SELECT COUNT(*) FROM shelf_books" },
      });
    });

    const bridge = (verb: string, body: Record<string, unknown>) => handleApiRequest(kernel, { method: "POST", path: `/api/pages/shelf/${verb}`, body });

    it("serves the page as HTML with its declarations, and its card its headline", async () => {
      const page = await handleApiRequest(kernel, { method: "GET", path: "/api/pages/shelf", body: {} });
      expect(page.body).toMatchObject({ kind: "html", page: { html: "<p>books</p>" } });
      const list = await handleApiRequest(kernel, { method: "GET", path: "/api/pages", body: {} });
      expect((list.body as { id: string; headline?: unknown }[]).find((p) => p.id === "shelf")?.headline).toEqual({ label: "Books", value: 1 });
    });

    it("answers the page's own queries and declared writes", async () => {
      expect((await bridge("write", { table: "shelf_books", op: "insert", values: { title: "Emma" } })).status).toBe(200);
      const read = await bridge("query", { sql: "SELECT title FROM shelf_books ORDER BY id" });
      expect((read.body as { rows: unknown[] }).rows).toEqual([{ title: "Dune" }, { title: "Emma" }]);
    });

    it("answers a trashed page's reads and refuses its writes, and draws it no new capture", async () => {
      kernel.pages.trash("shelf");
      const read = await bridge("query", { sql: "SELECT title FROM shelf_books" });
      expect(read.status).toBe(200);
      const write = await bridge("write", { table: "shelf_books", op: "insert", values: { title: "Emma" } });
      expect(write.status).toBe(403);
      expect(JSON.stringify(write.body)).toMatch(/in the trash/);
      expect((kernel.workspace.db.prepare("SELECT COUNT(*) AS n FROM shelf_books").get() as { n: number }).n).toBe(1);
      expect(kernel.audit.recent(5).find((r) => r.tool === "page.write")?.isError).toBe(true);
      expect((await handleApiRequest(kernel, { method: "POST", path: "/api/artifacts/shelf/check", body: {} })).status).toBe(409);
    });

    it("answers an owner's edit made on an older version with a conflict", async () => {
      kernel.pages.writeHtml("shelf", { id: "note", kind: "doc", title: "Note", html: "<article data-doc><h1>Note</h1><p>one</p></article>" });
      const opened = kernel.pages.get("note")!.record.updatedAt;
      kernel.pages.writeHtml("shelf", { id: "note", kind: "doc", title: "Note", html: "<article data-doc><h1>Note</h1><p>two</p></article>" });
      const late = await handleApiRequest(kernel, { method: "POST", path: "/api/pages/note/save", body: { edit: { doc: "<h1>Note</h1><p>mine</p>" }, base: opened - 1 } });
      expect(late.status).toBe(409);
      expect(JSON.stringify(late.body)).toMatch(/changed after it was opened.*Reload/);
      const base = kernel.pages.get("note")!.record.updatedAt;
      const saved = await handleApiRequest(kernel, { method: "POST", path: "/api/pages/note/save", body: { edit: { doc: "<h1>Note</h1><p>mine</p>" }, base } });
      expect(saved.status).toBe(200);
    });

    it("gives a blob's artifact no tables, keeps it the blob's through an edit, and keeps it when the blob goes", async () => {
      kernel.roles.write({ name: "noter", description: "Keeps notes", brief: "You keep notes.", memory: "own" });
      const rec = kernel.pages.writeHtml({ blob: "noter", id: kernel.roles.identity("noter")! }, { id: "notes", kind: "doc", title: "Notes", html: "<article data-doc><h1>Notes</h1><p>one</p></article>" });
      // A blob's turn reaches no tables, so neither does what it makes, even a project's it works beside.
      for (const sql of ["SELECT title FROM shelf_books", "SELECT token FROM vault_keys"]) {
        const read = await handleApiRequest(kernel, { method: "POST", path: "/api/pages/notes/query", body: { sql } });
        expect(read.status).toBe(403);
      }
      const saved = await handleApiRequest(kernel, { method: "POST", path: "/api/pages/notes/save", body: { edit: { doc: "<h1>Notes</h1><p>two</p>" }, base: rec.updatedAt } });
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({ blob: "noter", projectSlug: null });
      // Nothing is deleted from the dashboard straight away: it goes to the trash first.
      expect((await handleApiRequest(kernel, { method: "POST", path: "/api/artifacts/notes/delete", body: {} })).status).toBe(400);
      // Removed, its file goes and its folder stays with the work in it: the artifact is kept, marked as a removed blob's.
      expect((await handleApiRequest(kernel, { method: "POST", path: "/api/agents/delete", body: { name: "noter" } })).status).toBe(200);
      const list = (await handleApiRequest(kernel, { method: "GET", path: "/api/artifacts", body: {} })).body as { id: string; blob?: string; blobRemoved?: boolean }[];
      expect(list.find((p) => p.id === "notes")).toMatchObject({ blob: "noter", blobRemoved: true });
      // The owner can still restore a version of it, and delete it.
      expect((await handleApiRequest(kernel, { method: "POST", path: "/api/pages/notes/rollback", body: { version: 1 } })).status).toBe(200);
      expect((await handleApiRequest(kernel, { method: "POST", path: "/api/artifacts/notes/trash", body: {} })).status).toBe(200);
      expect((await handleApiRequest(kernel, { method: "POST", path: "/api/artifacts/notes/delete", body: {} })).status).toBe(200);
      expect(kernel.pages.get("notes")).toBeUndefined();
    });

    it("lets the owner delete a removed blob's artifact whose file is already gone, by its row", async () => {
      kernel.roles.write({ name: "noter", description: "Keeps notes", brief: "You keep notes.", memory: "own" });
      kernel.pages.writeHtml({ blob: "noter", id: kernel.roles.identity("noter")! }, { id: "notes", title: "Notes", html: "<p>n</p>" });
      expect((await handleApiRequest(kernel, { method: "POST", path: "/api/agents/delete", body: { name: "noter" } })).status).toBe(200);
      rmSync(join(root, "blobs/noter/artifacts/notes.html"));
      expect(kernel.pages.get("notes")).toBeUndefined();
      expect((await handleApiRequest(kernel, { method: "POST", path: "/api/artifacts/notes/trash", body: {} })).status).toBe(200);
      const res = await handleApiRequest(kernel, { method: "POST", path: "/api/artifacts/notes/delete", body: {} });
      expect(res).toMatchObject({ status: 200, body: { deleted: true } });
      expect(kernel.pages.record("notes")).toBeUndefined();
      expect(existsSync(join(root, "blobs/noter/artifacts/.history/notes"))).toBe(false);
      expect((await handleApiRequest(kernel, { method: "POST", path: "/api/artifacts/notes/delete", body: {} })).status).toBe(404);
    });

    it("lists what a blob made as a removed blob's once its folder was deleted by hand, without a reboot", async () => {
      kernel.roles.write({ name: "noter", description: "Keeps notes", brief: "You keep notes.", memory: "own" });
      kernel.pages.writeHtml({ blob: "noter", id: kernel.roles.identity("noter")! }, { id: "notes", title: "Notes", html: "<p>n</p>" });
      const listed = async (): Promise<{ id: string; blobRemoved?: boolean } | undefined> =>
        ((await handleApiRequest(kernel, { method: "GET", path: "/api/artifacts", body: {} })).body as { id: string; blobRemoved?: boolean }[]).find((p) => p.id === "notes");
      // Its file moved aside for a moment is still a living blob's.
      const file = join(root, "blobs/noter/blob.md");
      const text = readFileSync(file, "utf8");
      rmSync(file);
      expect((await listed())?.blobRemoved).toBeUndefined();
      writeFileSync(file, text);
      // The whole folder gone is the blob deleted: the list says so, and it can be let go.
      rmSync(join(root, "blobs/noter"), { recursive: true });
      expect(await listed()).toMatchObject({ blobRemoved: true });
      expect((await handleApiRequest(kernel, { method: "POST", path: "/api/artifacts/notes/trash", body: {} })).status).toBe(200);
      expect(await handleApiRequest(kernel, { method: "POST", path: "/api/artifacts/notes/delete", body: {} })).toMatchObject({ status: 200, body: { deleted: true } });
      expect(kernel.pages.record("notes")).toBeUndefined();
    });

    it("shows a mentioned artifact or its file only where the chat's tools could read it, and nothing to a guest", () => {
      kernel.roles.write({ name: "noter", description: "Keeps notes", brief: "You keep notes.", memory: "own" });
      kernel.pages.writeHtml({ blob: "noter", id: kernel.roles.identity("noter")! }, { id: "notes", title: "Notes", html: "<p>NOTE-BODY</p>" });
      mkdirSync(join(root, ".kos"), { recursive: true });
      writeFileSync(join(root, ".kos/secret.txt"), "KOS-STATE");
      const resolve = (text: string, conversationId: string | undefined, who: { guest?: { project: string | undefined; chat: string }; owner: boolean }): string =>
        (kernel as unknown as { resolveMentions: (t: string, c: string | undefined, w: typeof who) => string | null }).resolveMentions(text, conversationId, who) ?? "";
      const owner = { owner: true };
      const chat = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Shelf chat", projectSlug: "shelf" });
      // A project's chat sees its own page, and not a blob's, by @page or by its file.
      const there = resolve("@page:shelf @page:notes @file:blobs/noter/artifacts/notes.html @file:blobs/noter/artifacts/.history/notes/1.json", chat.id, owner);
      expect(there).toContain("<p>books</p>");
      expect(there).not.toContain("NOTE-BODY");
      expect(there).toMatch(/Page notes: not shown; This chat is Shelf's, so the blob noter's artifacts are not this chat's to read/);
      expect(there).toMatch(/File blobs\/noter\/artifacts\/notes.html: not shown/);
      // A change of case is the same file on a case-insensitive disk, and refused on any.
      const cased = resolve("@file:Blobs/noter/Artifacts/NOTES.html @file:blobs/noter/artifacts/.History/notes/1.json", chat.id, owner);
      expect(cased).not.toContain("NOTE-BODY");
      expect(cased.match(/not shown; .*part of the artifact notes/g)).toHaveLength(2);
      // The blob's own thread, and the owner's own chat at the root, see it.
      expect(resolve("@page:notes", kernel.ensureAgentConversation("noter").id, owner)).toContain("NOTE-BODY");
      const mine = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Mine" });
      expect(resolve("@file:blobs/noter/artifacts/notes.html", mine.id, owner)).toContain("NOTE-BODY");
      // A schedule's run at the root is not the owner's own chat.
      expect(resolve("@page:notes", mine.id, { owner: false })).not.toContain("NOTE-BODY");
      // KOS's own state is never shown.
      expect(resolve("@file:.kos/secret.txt", mine.id, owner)).not.toContain("KOS-STATE");
      for (const path of [".KOS/secret.txt", "notes/../.Kos/secret.txt"]) expect(resolve(`@file:${path}`, mine.id, owner)).toMatch(/KOS's own state and is not shown/);
      // A guest's words show nothing of the owner's, even in the project's own chat.
      const guest = resolve("@page:shelf @file:projects/shelf/pages/shelf.html @page:notes @file:notes.txt", chat.id, { guest: { project: "shelf", chat: chat.id }, owner: false });
      expect(guest).not.toContain("<p>books</p>");
      expect(guest).not.toContain("NOTE-BODY");
      expect(guest).toMatch(/Not shown, since a guest named them/);
    });

    it("shows a project's chat or a blob's thread KOS's own records only as its tools reach them, and the root all of them", () => {
      kernel.roles.write({ name: "noter", description: "Keeps notes", brief: "NOTER-BRIEF", memory: "own" });
      kernel.roles.write({ name: "locker", description: "Locks", brief: "LOCKER-BRIEF", memory: "own", project: "vault" });
      const theirs = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Vault chat", projectSlug: "vault", brief: "VAULT-CHAT-BRIEF" });
      const mine = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Shelf chat", projectSlug: "shelf", brief: "SHELF-CHAT-BRIEF" });
      const job = kernel.crons.create({ name: "rotate", schedule: "0 3 * * *", type: "self_prompt", prompt: "ROTATE-PROMPT", enabled: true, projectSlug: "vault" });
      const asked = kernel.approvals.enqueue({ tool: "files.read", args: { path: "VAULT-KEY" }, riskTier: "risky", conversationId: theirs.id });
      const resolve = (text: string, conversationId: string): string =>
        (kernel as unknown as { resolveMentions: (t: string, c: string, w: { owner: boolean }) => string | null }).resolveMentions(text, conversationId, { owner: true }) ?? "";
      const named = `@schedule:${job.id} @approval:${asked.id} @chat:[${theirs.id}] @blob:locker @blob:noter @chat:[${mine.id}]`;
      // Another project's chat: the schedule as cron.list has it, nothing of the approval, the chat or a blob's brief.
      const fenced = resolve(named, mine.id);
      for (const hidden of ["ROTATE-PROMPT", "VAULT-KEY", "VAULT-CHAT-BRIEF", "LOCKER-BRIEF", "NOTER-BRIEF"]) expect(fenced, hidden).not.toContain(hidden);
      expect(fenced).toMatch(/Schedule "rotate" \(id \d+\): 0 3 \* \* \*, type self_prompt, enabled\. Not this chat's/);
      expect(fenced).toContain("SHELF-CHAT-BRIEF");
      // A blob's thread: its own brief, nobody else's.
      const thread = resolve(named, kernel.ensureAgentConversation("noter").id);
      expect(thread).toContain("NOTER-BRIEF");
      for (const hidden of ["ROTATE-PROMPT", "VAULT-KEY", "VAULT-CHAT-BRIEF", "LOCKER-BRIEF", "SHELF-CHAT-BRIEF"]) expect(thread, hidden).not.toContain(hidden);
      // The project's own chat sees its own; the owner's root chat, everything.
      const own = resolve(named, theirs.id);
      for (const shown of ["ROTATE-PROMPT", "VAULT-KEY", "VAULT-CHAT-BRIEF", "LOCKER-BRIEF"]) expect(own, shown).toContain(shown);
      const root = resolve(named, kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Mine" }).id);
      for (const shown of ["ROTATE-PROMPT", "VAULT-KEY", "VAULT-CHAT-BRIEF", "LOCKER-BRIEF", "NOTER-BRIEF", "SHELF-CHAT-BRIEF"]) expect(root, shown).toContain(shown);
    });

    describe("the owner's management", () => {
      const manage = (id: string, verb: string, body: Record<string, unknown> = {}, headers?: Record<string, string>) =>
        handleApiRequest(kernel, { method: "POST", path: `/api/artifacts/${id}/${verb}`, body, ...(headers ? { headers } : {}) }, headers ? { token: "secret" } : {});
      const audited = (verb: string) => kernel.audit.recent(50).filter((r) => r.tool === `artifact.${verb}`);
      const listed = async (trashed = false): Promise<string[]> =>
        ((await handleApiRequest(kernel, { method: "GET", path: "/api/artifacts", url: `/api/artifacts${trashed ? "?trashed=1" : ""}`, body: {} })).body as { id: string }[]).map((r) => r.id).sort();

      it("is the owner's alone, behind the dashboard's token", async () => {
        for (const verb of ["rename", "duplicate", "move", "trash", "restore", "delete"]) {
          expect((await handleApiRequest(kernel, { method: "POST", path: `/api/artifacts/shelf/${verb}`, body: { title: "X" } }, { token: "secret" })).status, verb).toBe(401);
        }
        expect(kernel.pages.record("shelf")).toMatchObject({ title: "Shelf" });
        expect((await manage("shelf", "rename", { title: "Books" }, { "x-kos-token": "secret" })).status).toBe(200);
      });

      it("renames, copies and moves an artifact under its id, each audited", async () => {
        const renamed = await manage("shelf", "rename", { title: "Books", description: "Every book on the shelf." });
        expect(renamed).toMatchObject({ status: 200, body: { id: "shelf", title: "Books", description: "Every book on the shelf." } });
        expect(audited("rename")[0]).toMatchObject({ isError: false, userId: kernel.profile.ownerId });
        expect(JSON.parse(audited("rename")[0]!.args)).toMatchObject({ id: "shelf", title: "Books" });
        expect((await manage("shelf", "rename", { title: "x".repeat(121) })).status).toBe(400);
        expect((await manage("shelf", "rename", { description: "x".repeat(281) })).status).toBe(400);
        expect(kernel.pages.record("shelf")?.title).toBe("Books");

        const copy = await manage("shelf", "duplicate");
        expect(copy).toMatchObject({ status: 200, body: { id: "shelf-copy", title: "Books copy", projectSlug: "shelf" } });
        expect(audited("duplicate")).toHaveLength(1);

        kernel.pages.writeHtml(null, { id: "memo", title: "Memo", html: "<p>memo</p>" });
        kernel.roles.write({ name: "noter", description: "Keeps notes", brief: "You keep notes.", memory: "own" });
        expect(await manage("memo", "move", { project: "vault" })).toMatchObject({ status: 200, body: { id: "memo", projectSlug: "vault" } });
        expect(await manage("memo", "move", { blob: "noter" })).toMatchObject({ status: 200, body: { blob: "noter" } });
        expect(await manage("memo", "move", { project: "@workspace" })).toMatchObject({ status: 200, body: { projectSlug: null } });
        expect(kernel.pages.history("memo")).toHaveLength(4);
        // One that reads its project's tables does not go where they are not, and the refusal is audited too.
        const refused = await manage("shelf", "move", { project: "vault" });
        expect(refused.status).toBe(400);
        expect((refused.body as { error: string }).error).toMatch(/not a table of project "vault"/);
        expect(audited("move").map((r) => r.isError)).toEqual([true, false, false, false]);
        expect((await manage("memo", "move", {})).status).toBe(400);
        // Maintenance is KOS's repair shop: no artifact of the owner's is filed there from the dashboard.
        const kept = await manage("memo", "move", { project: "maintenance" });
        expect(kept.status).toBe(400);
        expect((kept.body as { error: string }).error).toMatch(/where KOS repairs itself/);
        expect((await manage("nope", "rename", { title: "X" })).status).toBe(404);
      });

      it("trashes into a list of its own, restores, and deletes for good only from the trash", async () => {
        kernel.pages.writeHtml(null, { id: "memo", title: "Memo", html: "<p>memo</p>" });
        expect((await manage("memo", "delete")).status).toBe(400);
        expect(kernel.pages.record("memo")).toBeDefined();

        expect(await manage("memo", "trash")).toMatchObject({ status: 200, body: { id: "memo", trashedAt: expect.any(Number) } });
        expect(await listed()).toEqual(["shelf"]);
        expect(await listed(true)).toEqual(["memo"]);
        // Out of the project's list and the @ menu too.
        expect((await manage("shelf", "trash")).status).toBe(200);
        expect(((await handleApiRequest(kernel, { method: "GET", path: "/api/pages", url: "/api/pages?project=shelf", body: {} })).body as unknown[]).length).toBe(0);
        expect(mentionsOf(kernel, "she", 10, "page")).toEqual([]);
        // Still opened by its id, saying it is in the trash, and nothing changes it there.
        expect((await handleApiRequest(kernel, { method: "GET", path: "/api/pages/memo", body: {} })).body).toMatchObject({ record: { trashedAt: expect.any(Number) } });
        expect((await manage("memo", "rename", { title: "X" })).status).toBe(409);
        expect((await handleApiRequest(kernel, { method: "POST", path: "/api/pages/memo/rollback", body: { version: 1 } })).status).toBe(400);

        expect(await manage("shelf", "restore")).toMatchObject({ status: 200, body: { id: "shelf" } });
        expect(await listed()).toEqual(["shelf"]);
        expect(await manage("memo", "delete")).toMatchObject({ status: 200, body: { id: "memo", deleted: true } });
        expect(kernel.pages.record("memo")).toBeUndefined();
        expect(audited("trash")).toHaveLength(2);
        expect(audited("restore")).toHaveLength(1);
        expect(audited("delete").map((r) => r.isError)).toEqual([false, true]);
      });

      it("tells a chat that mentions a trashed artifact where it is, without its body", () => {
        kernel.pages.trash("shelf");
        const chat = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Shelf chat", projectSlug: "shelf" });
        const said = (kernel as unknown as { resolveMentions: (t: string, c: string, w: { owner: boolean }) => string | null }).resolveMentions("@page:shelf", chat.id, { owner: true }) ?? "";
        expect(said).toMatch(/Page shelf \("Shelf"\): in the trash/);
        expect(said).not.toContain("<p>books</p>");
      });
    });

    it("gives a guest's turn no artifact or file tool, so a guest never reaches the root's reach over a blob's artifacts", () => {
      expect(GUEST_TOOLS.filter((t) => t.startsWith("artifacts.") || t.startsWith("files.") || t === "pages.write")).toEqual([]);
    });

    it("knows a blob's own thread by its id, not by its having no project", async () => {
      kernel.roles.write({ name: "noter", description: "Keeps notes", brief: "You keep notes.", memory: "own" });
      const write = (conversationId: string, id: string) => caller.run(conversationId, () => kernel.registry.execute("artifacts.write", { id, title: id, html: `<h1>${id}</h1>` }));
      const home = kernel.ensureAgentConversation("noter");
      expect((await write(home.id, "own")).isError).toBe(false);
      expect(kernel.pages.record("own")).toMatchObject({ blob: "noter", blobId: kernel.roles.identity("noter") });
      // Its chat in a project works for the project, and is still not its own thread once the project is deleted.
      const there = kernel.spawnAgent("noter", "shelf");
      kernel.deleteProject("shelf");
      expect(kernel.conversations.get(there.id)).toMatchObject({ projectSlug: null, role: "noter" });
      expect((await write(there.id, "after")).isError).toBe(false);
      expect(kernel.pages.record("after")?.blob).toBeUndefined();
      // Removed, its thread is nobody's: what it writes is not the old blob's, and a new noter is a new owner.
      kernel.roles.remove("noter");
      expect((await write(home.id, "orphan")).isError).toBe(false);
      expect(kernel.pages.record("orphan")?.blob).toBeUndefined();
      kernel.roles.write({ name: "noter", description: "Again", brief: "Again.", memory: "own" });
      const again = await caller.run(home.id, () => kernel.registry.execute("artifacts.get", { id: "own" }));
      expect(again.isError).toBe(true);
    });

    /*
     * A page query and a headline are the agent's SQL, run whenever the owner
     * looks. One that never ends held the server's only thread, and with it
     * every request, until it did.
     */
    it("stops a query or a headline that never ends, and answers everything else meanwhile", async () => {
      const never = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT COUNT(*) FROM n, shelf_books";
      kernel.pages.writeHtml("shelf", { id: "slow", title: "Slow", html: "<p>slow</p>", headline: { label: "Never", query: never } });
      let ticks = 0;
      const tick = setInterval(() => (ticks += 1), 20);
      const pending = handleApiRequest(kernel, { method: "POST", path: "/api/pages/slow/query", body: { sql: never } });
      const other = await handleApiRequest(kernel, { method: "GET", path: "/api/pages/shelf", body: {} });
      expect(other.status).toBe(200);
      const res = await pending;
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).toMatch(/ran past/);
      const started = Date.now();
      const list = await handleApiRequest(kernel, { method: "GET", path: "/api/pages", body: {} });
      expect(Date.now() - started).toBeLessThan(2000);
      clearInterval(tick);
      expect(ticks).toBeGreaterThan(20);
      const cards = list.body as { id: string; headline?: unknown }[];
      expect(cards.find((p) => p.id === "slow")?.headline).toBeUndefined();
      expect(cards.find((p) => p.id === "shelf")?.headline).toEqual({ label: "Books", value: 1 });
      // Kept, not run again on every list.
      const again = Date.now();
      await handleApiRequest(kernel, { method: "GET", path: "/api/pages", body: {} });
      expect(Date.now() - again).toBeLessThan(200);
    });

    it("keeps one page's pile of slow queries from holding another page or the page list", async () => {
      const never = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT COUNT(*) FROM n, shelf_books";
      kernel.pages.writeHtml("shelf", { id: "hog", title: "Hog", html: "<p>hog</p>", headline: { label: "Never", query: never } });
      const piled = Array.from({ length: 100 }, () => handleApiRequest(kernel, { method: "POST", path: "/api/pages/hog/query", body: { sql: never } }));
      const started = Date.now();
      const other = await bridge("query", { sql: "SELECT title FROM shelf_books" });
      expect(other.status).toBe(200);
      expect(Date.now() - started).toBeLessThan(800);
      const listed = Date.now();
      const list = await handleApiRequest(kernel, { method: "GET", path: "/api/pages", body: {} });
      expect(Date.now() - listed).toBeLessThan(1600);
      expect((list.body as { id: string; headline?: unknown }[]).find((p) => p.id === "shelf")?.headline).toEqual({ label: "Books", value: 1 });
      const answers = await Promise.all(piled);
      expect(answers.every((a) => a.status === 403)).toBe(true);
      expect(answers.filter((a) => /too many queries waiting/.test(JSON.stringify(a.body))).length).toBeGreaterThanOrEqual(90);
    });

    it("refuses another project's table, an undeclared write and the old widget route, and logs the refusal", async () => {
      const stolen = await bridge("query", { sql: "SELECT token FROM vault_keys" });
      expect(stolen.status).toBe(403);
      expect(JSON.stringify(stolen.body)).not.toContain("keep me");
      expect((await bridge("write", { table: "vault_keys", op: "insert", values: { token: "x" } })).status).toBe(403);
      expect((await handleApiRequest(kernel, { method: "POST", path: "/api/mutate", body: { pageId: "shelf", widgetIndex: 0, op: "insert", values: {} } })).status).toBe(404);
      expect(kernel.audit.recent(5).some((r) => r.tool === "page.query" && r.isError)).toBe(true);
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

describe("the Discord server's channels", () => {
  it("lists them with whose home each is, and offers them as things to name", async () => {
    const root = mkdtempSync(join(tmpdir(), "kos-api-"));
    const known: ServerPlace[] = [
      { id: "c1", name: "garden", kind: "channel", category: "Projects", bound: "project:garden", audience: "owner", url: "https://discord.com/channels/g1/c1" },
      { id: "c5", name: "general", kind: "channel", audience: "everyone", url: "https://discord.com/channels/g1/c5", topic: "Say hi" },
    ];
    const k = await Kernel.boot({
      rootDir: root,
      secrets: new SecretsRegistry(),
      inference: stub,
      discord: { connected: () => true, known: () => known } as unknown as DiscordServices,
    });
    try {
      const listed = await handleApiRequest(k, { method: "GET", path: "/api/discord/channels" });
      expect(listed.body).toEqual({
        channels: [
          { id: "c1", name: "garden", url: "https://discord.com/channels/g1/c1", category: "Projects", bound: "project:garden", home: "project:garden", audience: "owner" },
          { id: "c5", name: "general", url: "https://discord.com/channels/g1/c5", audience: "everyone" },
        ],
      });
      const found = await handleApiRequest(k, { method: "GET", path: "/api/mentions", url: "/api/mentions?q=gar&kind=channel" });
      expect((found.body as { mentions: unknown[] }).mentions).toEqual([
        { kind: "channel", id: "garden", label: "#garden", hint: "Projects · home of project:garden", url: "https://discord.com/channels/g1/c1" },
      ]);
    } finally {
      k.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("has none to list when KOS lives in no server", async () => {
    const root = mkdtempSync(join(tmpdir(), "kos-api-"));
    const k = await Kernel.boot({ rootDir: root, secrets: new SecretsRegistry(), inference: stub });
    try {
      expect((await handleApiRequest(k, { method: "GET", path: "/api/discord/channels" })).body).toEqual({ channels: [] });
    } finally {
      k.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a file as words", () => {
  it("serves a text file's words, and says when there are none to read", async () => {
    const root = mkdtempSync(join(tmpdir(), "kos-api-"));
    writeFileSync(join(root, "notes.txt"), "hello there");
    writeFileSync(join(root, "photo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const k = await Kernel.boot({ rootDir: root, secrets: new SecretsRegistry(), inference: stub });
    try {
      const words = await handleApiRequest(k, { method: "GET", path: "/api/file/text", url: "/api/file/text?path=notes.txt" });
      expect(words.body).toEqual({ path: "notes.txt", text: "hello there" });
      const none = await handleApiRequest(k, { method: "GET", path: "/api/file/text", url: "/api/file/text?path=photo.png" });
      expect(none.status).toBe(400);
      expect((await handleApiRequest(k, { method: "GET", path: "/api/file/text" })).status).toBe(400);
    } finally {
      k.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("approvals already decided", () => {
  it("are kept, newest first, said in words, so a link to one still lands", async () => {
    const root = mkdtempSync(join(tmpdir(), "kos-api-"));
    const k = await Kernel.boot({ rootDir: root, secrets: new SecretsRegistry(), inference: stub });
    try {
      const a = k.approvals.enqueue({ tool: "cron.run", args: { id: 1 }, riskTier: "risky", reason: "runs it" });
      const b = k.approvals.enqueue({ tool: "files.rm", args: { path: "x.txt" }, riskTier: "risky", reason: "outside the scratch folder" });
      k.approvals.deny(a.id, "owner");
      k.approvals.approve(b.id, "owner");
      const history = (await handleApiRequest(k, { method: "GET", path: "/api/approvals/history", url: "/api/approvals/history?limit=10" })).body as { id: number; status: string; summary: string; decidedBy: string | null }[];
      expect(history.map((h) => [h.id, h.status, h.decidedBy])).toEqual([
        [b.id, "approved", "owner"],
        [a.id, "denied", "owner"],
      ]);
      expect(history[0]?.summary).toBe("Delete x.txt");
      expect((await handleApiRequest(k, { method: "GET", path: "/api/approvals" })).body).toEqual([]);
    } finally {
      k.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
