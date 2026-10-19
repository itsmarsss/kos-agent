import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { RoleStore, type Role } from "../agents/roles.js";
import { ConversationStore } from "../kernel/conversations.js";
import { ModuleLoader, toolRegistryContext } from "../modules/loader.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Workspace } from "../store/workspace.js";
import { createAgentsModule, type BlobJob } from "./agents.js";

/**
 * The blobs tools, driven through the registry with the kernel's part
 * scripted: what gets written, which thread work goes to, and what the
 * schedule is told to be. The kernel's own half is covered in kernel.test.
 */

const OWNER = "owner";
const DISPATCHER = "orchestrator:owner";
const NOON = Date.UTC(2026, 9, 18, 12);

interface Harness {
  registry: ToolRegistry;
  roles: RoleStore;
  conversations: ConversationStore;
  call: (name: string, input?: Record<string, unknown>) => Promise<{ content: string; isError: boolean; json?: Record<string, unknown> }>;
  asked: Array<{ id: string; text: string }>;
  bound: Array<{ name: string; schedule: string | undefined }>;
  /** The jobs the scripted scheduler holds, by blob. */
  jobs: Map<string, BlobJob>;
  done: string[];
}

async function harness(ws: Workspace, options: { scope?: string } = {}): Promise<Harness> {
  const roles = new RoleStore(ws);
  const conversations = new ConversationStore(ws.db);
  const registry = new ToolRegistry();
  const asked: Harness["asked"] = [];
  const bound: Harness["bound"] = [];
  const jobs = new Map<string, BlobJob>();
  const done: string[] = [];
  const ctx = toolRegistryContext(registry, { workspace: ws, db: ws.db, secrets: new SecretsRegistry() });
  await new ModuleLoader(ctx).load([
    createAgentsModule({
      roles,
      ownerId: OWNER,
      scope: () => options.scope,
      currentConversationId: () => DISPATCHER,
      ensureAgent: (name) => conversations.get(`agent:${name}`) ?? conversations.create({ id: `agent:${name}`, userId: OWNER, title: name, role: name }),
      spawnAgent: (name, projectSlug) => conversations.create({ userId: OWNER, title: name, role: name, projectSlug }),
      bindSchedule: (name, role: Role | undefined) => {
        bound.push({ name, schedule: role?.schedule });
        if (!role?.schedule) {
          jobs.delete(name);
          return undefined;
        }
        jobs.set(name, { id: 7, schedule: role.schedule, enabled: true, lastRunAt: null, nextRunAt: NOON });
        return { id: 7, schedule: role.schedule };
      },
      timezone: () => "UTC",
      jobOf: (name) => jobs.get(name),
      setJobEnabled: (name, enabled) => {
        const job = jobs.get(name);
        if (!job) return undefined;
        const next = { ...job, enabled, nextRunAt: enabled ? NOON : null };
        jobs.set(name, next);
        return next;
      },
      dispatch: async (id, text) => {
        asked.push({ id, text });
        return { reply: "done", conversationId: id };
      },
      onDispatchDone: (id, title, reply, from) => done.push(`${from} <- ${id} (${title}): ${reply}`),
    }),
  ]);
  const call: Harness["call"] = async (name, input = {}) => {
    const res = await registry.execute(name, input);
    return { ...res, json: res.isError ? undefined : (JSON.parse(res.content) as Record<string, unknown>) };
  };
  return { registry, roles, conversations, call, asked, bound, jobs, done };
}

describe("blobs tools", () => {
  let root: string;
  let ws: Workspace;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-agents-"));
    ws = Workspace.open(root);
  });
  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("makes an agent as a file, a thread and a schedule, and refuses a second of the same name", async () => {
    const h = await harness(ws);
    const made = (await h.call("blobs.create", {
      name: "Price-Watch",
      description: "Watches one listing",
      brief: "You watch one listing and tell the owner when it drops.",
      schedule: "0 */6 * * *",
      prompt: "Look at the listing.",
      task: "cheap",
      report: "always",
      face: { hue: 210, eyes: "sparkle", gait: 7 },
    })).json!;
    expect(made).toMatchObject({ name: "price-watch", path: "blobs/price-watch/blob.md", conversationId: "agent:price-watch", job: { id: 7, schedule: "0 */6 * * *" } });
    expect(existsSync(join(root, "blobs", "price-watch", "blob.md"))).toBe(true);
    // The face the owner asked for, less the part that was out of range; and that each run reports.
    expect(h.roles.get("price-watch")).toMatchObject({ schedule: "0 */6 * * *", prompt: "Look at the listing.", task: "cheap", memory: "own", report: "always", face: { hue: 210, eyes: "sparkle" } });
    expect(h.roles.get("price-watch")!.face).not.toHaveProperty("gait");
    expect(h.conversations.get("agent:price-watch")).toMatchObject({ role: "price-watch" });
    expect(h.bound).toEqual([{ name: "price-watch", schedule: "0 */6 * * *" }]);

    const again = await h.call("blobs.create", { name: "price-watch", description: "x", brief: "y" });
    expect(again.isError).toBe(true);
    expect(again.content).toMatch(/already a blob called price-watch/);
    // Rewritten without a schedule, the job goes with it.
    const replaced = (await h.call("blobs.create", { name: "price-watch", description: "Watches one listing", brief: "You watch.", replace: true, tools: ["browser"] })).json!;
    expect(replaced["job"]).toBeUndefined();
    expect(h.bound.at(-1)).toEqual({ name: "price-watch", schedule: undefined });
    expect(h.roles.get("price-watch")).toMatchObject({ brief: "You watch.", tools: ["browser"] });

    expect((await h.call("blobs.create", { name: "bad", description: "x", brief: "y", schedule: "every tuesday", prompt: "p" })).content).toMatch(/not a cron schedule/);
    expect((await h.call("blobs.create", { name: "bad", description: "x", brief: "y", schedule: "0 4 * * *" })).content).toMatch(/needs a prompt/);
    expect((await h.call("blobs.create", { name: "Not A Name", description: "x", brief: "y" })).content).toMatch(/short and plain/);
    expect(h.roles.exists("bad")).toBe(false);
  });

  it("lists what a chooser needs, with whether each will run on its own", async () => {
    const h = await harness(ws);
    await h.call("blobs.create", { name: "research", description: "Looks things up", brief: "You look." });
    const listed = (await h.call("blobs.list")).json!;
    expect(listed).toEqual({
      blobs: [{ name: "research", description: "Looks things up", tools: "all", memory: "own", state: "on request", conversationId: "agent:research", path: "blobs/research/blob.md", folder: "blobs/research" }],
    });

    await h.call("blobs.create", { name: "recap", description: "Sums up the day", brief: "You recap.", schedule: "0 18 * * *", prompt: "Recap." });
    h.jobs.set("recap", { ...h.jobs.get("recap")!, lastRunAt: NOON - 86_400_000 });
    const scheduled = ((await h.call("blobs.list")).json!["blobs"] as Record<string, unknown>[]).find((b) => b["name"] === "recap");
    // The state is the job's, with when it ran and when it will, not the
    // file's line alone: the owner's words to quote, the exact moment beside.
    expect(scheduled).toMatchObject({
      state: "scheduled",
      schedule: "0 18 * * *",
      lastRun: { words: expect.stringMatching(/ 12:00$/), at: "2026-10-17T12:00:00.000Z" },
      nextRun: { words: expect.stringMatching(/ 12:00$/), at: "2026-10-18T12:00:00.000Z" },
    });
  });

  it("pauses and resumes a schedule, and says so when there is none", async () => {
    const h = await harness(ws);
    await h.call("blobs.create", { name: "recap", description: "Sums up the day", brief: "You recap.", schedule: "0 18 * * *", prompt: "Recap." });
    await h.call("blobs.create", { name: "research", description: "Looks things up", brief: "You look." });

    const paused = (await h.call("blobs.pause", { name: "Recap" })).json!;
    expect(paused).toMatchObject({ name: "recap", state: "paused", schedule: "0 18 * * *" });
    expect(paused).not.toHaveProperty("nextRun");
    expect(h.jobs.get("recap")!.enabled).toBe(false);
    expect(((await h.call("blobs.list")).json!["blobs"] as Record<string, unknown>[]).find((b) => b["name"] === "recap")).toMatchObject({ state: "paused" });

    const resumed = (await h.call("blobs.resume", { name: "recap" })).json!;
    expect(resumed).toMatchObject({ name: "recap", state: "scheduled", nextRun: { at: "2026-10-18T12:00:00.000Z" } });
    expect(h.jobs.get("recap")!.enabled).toBe(true);

    expect((await h.call("blobs.pause", { name: "research" })).content).toMatch(/no schedule to pause/);
    expect((await h.call("blobs.resume", { name: "research" })).content).toMatch(/no schedule to resume/);
    expect((await h.call("blobs.pause", { name: "nobody" })).content).toMatch(/no blob called nobody/);
    for (const safe of ["blobs.pause", "blobs.resume"]) expect(h.registry.classify(safe, {}).tier).toBe("safe");
  });

  it("dispatches to the standing thread at the root, and into the project from a project", async () => {
    const h = await harness(ws);
    await h.call("blobs.create", { name: "research", description: "Looks things up", brief: "You look." });
    const sent = (await h.call("blobs.dispatch", { agent: "research", task: "Find the best kettle." })).json!;
    expect(sent).toMatchObject({ conversationId: "agent:research", started: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.asked).toEqual([{ id: "agent:research", text: "Find the best kettle." }]);
    expect(h.done).toEqual(["orchestrator:owner <- agent:research (research): done"]);
    expect((await h.call("blobs.dispatch", { agent: "nobody", task: "x" })).content).toMatch(/no blob called nobody/);

    // A project orchestrator gets the agent as a chat of its own project.
    const inside = await harness(ws, { scope: "trip" });
    const spawned = (await inside.call("blobs.dispatch", { agent: "research", task: "Find flights." })).json!;
    expect(spawned["conversationId"]).not.toBe("agent:research");
    expect(spawned["project"]).toBe("trip");
    expect(inside.conversations.get(spawned["conversationId"] as string)).toMatchObject({ role: "research", projectSlug: "trip" });
    expect((await inside.call("blobs.dispatch", { agent: "research", task: "x", project: "other" })).content).toMatch(/only be sent into trip/);
  });

  it("removes the file and the schedule, and leaves the thread; only that one asks", async () => {
    const h = await harness(ws);
    await h.call("blobs.create", { name: "research", description: "Looks things up", brief: "You look.", schedule: "0 9 * * 1", prompt: "Read." });
    expect((await h.call("blobs.remove", { name: "research" })).json).toMatchObject({ removed: "research" });
    expect(h.roles.exists("research")).toBe(false);
    expect(h.bound.at(-1)).toEqual({ name: "research", schedule: undefined });
    expect(h.conversations.get("agent:research")).toBeDefined();
    expect((await h.call("blobs.remove", { name: "research" })).isError).toBe(true);
    for (const safe of ["blobs.list", "blobs.create", "blobs.dispatch"]) expect(h.registry.classify(safe, {}).tier).toBe("safe");
    expect(h.registry.classify("blobs.remove", {}).tier).toBe("risky");
  });
});
