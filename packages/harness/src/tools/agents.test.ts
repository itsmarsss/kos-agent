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
import { createAgentsModule } from "./agents.js";

/**
 * The agents tools, driven through the registry with the kernel's part
 * scripted: what gets written, which thread work goes to, and what the
 * schedule is told to be. The kernel's own half is covered in kernel.test.
 */

const OWNER = "owner";
const DISPATCHER = "orchestrator:owner";

interface Harness {
  registry: ToolRegistry;
  roles: RoleStore;
  conversations: ConversationStore;
  call: (name: string, input?: Record<string, unknown>) => Promise<{ content: string; isError: boolean; json?: Record<string, unknown> }>;
  asked: Array<{ id: string; text: string }>;
  bound: Array<{ name: string; schedule: string | undefined }>;
  done: string[];
}

async function harness(ws: Workspace, options: { scope?: string } = {}): Promise<Harness> {
  const roles = new RoleStore(ws);
  const conversations = new ConversationStore(ws.db);
  const registry = new ToolRegistry();
  const asked: Harness["asked"] = [];
  const bound: Harness["bound"] = [];
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
        return role?.schedule ? { id: 7, schedule: role.schedule } : undefined;
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
  return { registry, roles, conversations, call, asked, bound, done };
}

describe("agents tools", () => {
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
    const made = (await h.call("agents.create", {
      name: "Price-Watch",
      description: "Watches one listing",
      brief: "You watch one listing and tell the owner when it drops.",
      schedule: "0 */6 * * *",
      prompt: "Look at the listing.",
      task: "cheap",
      face: { hue: 210, eyes: "sparkle", gait: 7 },
    })).json!;
    expect(made).toMatchObject({ name: "price-watch", path: "agents/price-watch.md", conversationId: "agent:price-watch", job: { id: 7, schedule: "0 */6 * * *" } });
    expect(existsSync(join(root, "agents", "price-watch.md"))).toBe(true);
    // The face the owner asked for, less the part that was out of range.
    expect(h.roles.get("price-watch")).toMatchObject({ schedule: "0 */6 * * *", prompt: "Look at the listing.", task: "cheap", memory: "own", face: { hue: 210, eyes: "sparkle" } });
    expect(h.roles.get("price-watch")!.face).not.toHaveProperty("gait");
    expect(h.conversations.get("agent:price-watch")).toMatchObject({ role: "price-watch" });
    expect(h.bound).toEqual([{ name: "price-watch", schedule: "0 */6 * * *" }]);

    const again = await h.call("agents.create", { name: "price-watch", description: "x", brief: "y" });
    expect(again.isError).toBe(true);
    expect(again.content).toMatch(/already an agent called price-watch/);
    // Rewritten without a schedule, the job goes with it.
    const replaced = (await h.call("agents.create", { name: "price-watch", description: "Watches one listing", brief: "You watch.", replace: true, tools: ["browser"] })).json!;
    expect(replaced["job"]).toBeUndefined();
    expect(h.bound.at(-1)).toEqual({ name: "price-watch", schedule: undefined });
    expect(h.roles.get("price-watch")).toMatchObject({ brief: "You watch.", tools: ["browser"] });

    expect((await h.call("agents.create", { name: "bad", description: "x", brief: "y", schedule: "every tuesday", prompt: "p" })).content).toMatch(/not a cron schedule/);
    expect((await h.call("agents.create", { name: "bad", description: "x", brief: "y", schedule: "0 4 * * *" })).content).toMatch(/needs a prompt/);
    expect((await h.call("agents.create", { name: "Not A Name", description: "x", brief: "y" })).content).toMatch(/short and plain/);
    expect(h.roles.exists("bad")).toBe(false);
  });

  it("lists what a chooser needs", async () => {
    const h = await harness(ws);
    await h.call("agents.create", { name: "research", description: "Looks things up", brief: "You look." });
    const listed = (await h.call("agents.list")).json!;
    expect(listed).toEqual({
      agents: [{ name: "research", description: "Looks things up", tools: "all", memory: "own", conversationId: "agent:research", path: "agents/research.md" }],
    });
  });

  it("dispatches to the standing thread at the root, and into the project from a project", async () => {
    const h = await harness(ws);
    await h.call("agents.create", { name: "research", description: "Looks things up", brief: "You look." });
    const sent = (await h.call("agents.dispatch", { agent: "research", task: "Find the best kettle." })).json!;
    expect(sent).toMatchObject({ conversationId: "agent:research", started: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.asked).toEqual([{ id: "agent:research", text: "Find the best kettle." }]);
    expect(h.done).toEqual(["orchestrator:owner <- agent:research (research): done"]);
    expect((await h.call("agents.dispatch", { agent: "nobody", task: "x" })).content).toMatch(/no agent called nobody/);

    // A project orchestrator gets the agent as a chat of its own project.
    const inside = await harness(ws, { scope: "trip" });
    const spawned = (await inside.call("agents.dispatch", { agent: "research", task: "Find flights." })).json!;
    expect(spawned["conversationId"]).not.toBe("agent:research");
    expect(spawned["project"]).toBe("trip");
    expect(inside.conversations.get(spawned["conversationId"] as string)).toMatchObject({ role: "research", projectSlug: "trip" });
    expect((await inside.call("agents.dispatch", { agent: "research", task: "x", project: "other" })).content).toMatch(/only be sent into trip/);
  });

  it("removes the file and the schedule, and leaves the thread; only that one asks", async () => {
    const h = await harness(ws);
    await h.call("agents.create", { name: "research", description: "Looks things up", brief: "You look.", schedule: "0 9 * * 1", prompt: "Read." });
    expect((await h.call("agents.remove", { name: "research" })).json).toMatchObject({ removed: "research" });
    expect(h.roles.exists("research")).toBe(false);
    expect(h.bound.at(-1)).toEqual({ name: "research", schedule: undefined });
    expect(h.conversations.get("agent:research")).toBeDefined();
    expect((await h.call("agents.remove", { name: "research" })).isError).toBe(true);
    for (const safe of ["agents.list", "agents.create", "agents.dispatch"]) expect(h.registry.classify(safe, {}).tier).toBe("safe");
    expect(h.registry.classify("agents.remove", {}).tier).toBe("risky");
  });
});
