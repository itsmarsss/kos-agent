import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { AuditLog } from "../ops/audit.js";
import { ApprovalQueue } from "../ops/approvals.js";
import { PermissionStore, actsInYourChrome } from "../ops/permissions.js";
import { RISKY } from "../risk/tiers.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Workspace } from "../store/workspace.js";
import { caller, isAttended, isOwnerTurn, turnStop } from "./caller.js";
import { GuardedTools, STOPPED_RESULT, finishedAfterStop, type GuardedToolsDeps } from "./guarded.js";

describe("GuardedTools", () => {
  let root: string;
  let ws: Workspace;
  let registry: ToolRegistry;
  let audit: AuditLog;
  let approvals: ApprovalQueue;
  let secrets: SecretsRegistry;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-guarded-"));
    ws = Workspace.open(root);
    registry = new ToolRegistry();
    audit = new AuditLog(ws.db);
    approvals = new ApprovalQueue(ws.db);
    secrets = new SecretsRegistry({ openai: "sk-real" });
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  function guarded(over: Partial<GuardedToolsDeps> = {}): GuardedTools {
    return new GuardedTools({ registry, secrets, audit, approvals, ...over });
  }

  it("tells a tool whether the owner started the turn calling it", async () => {
    registry.register({ name: "probe", description: "p", inputSchema: { type: "object" } }, () => (isAttended() ? "attended" : "unattended"));
    expect((await guarded({ conversationId: "c1" }).execute("probe", {})).content).toBe("attended");
    expect((await guarded({ conversationId: "cron:3", attended: false }).execute("probe", {})).content).toBe("unattended");
    // Outside any call, nothing is known to be unattended.
    expect(isAttended()).toBe(true);
  });

  it("tells a tool the turn is the owner's only when its door said so, and never an unattended one's", async () => {
    registry.register({ name: "whose", description: "w", inputSchema: { type: "object" } }, () => (isOwnerTurn() ? "owner" : "not"));
    expect((await guarded({ conversationId: "c1", owner: true }).execute("whose", {})).content).toBe("owner");
    expect((await guarded({ conversationId: "c1" }).execute("whose", {})).content).toBe("not");
    expect((await guarded({ conversationId: "c1", owner: true, attended: false }).execute("whose", {})).content).toBe("not");
    // Outside any call, nobody is taken for the owner.
    expect(isOwnerTurn()).toBe(false);
  });

  it("offers a granted tool past the allow-list, restricted or not", () => {
    registry.register({ name: "memory.recall", description: "m", inputSchema: { type: "object" } }, () => "ok");
    registry.register({ name: "discord.messages", description: "d", inputSchema: { type: "object" } }, () => "ok", { floor: "safe" }, { restricted: false });
    registry.register({ name: "chats.list", description: "c", inputSchema: { type: "object" } }, () => "ok", { floor: "safe" }, { restricted: true });
    const names = (tools: GuardedTools): string[] => tools.defs().map((d) => d.name).sort();
    // The orchestrator's shape: memory, plus what it is handed.
    expect(names(guarded({ allow: ["memory"], grant: ["discord.messages", "chats.list"] }))).toEqual(["chats.list", "discord.messages", "memory.recall"]);
    expect(names(guarded({ allow: ["memory"] }))).toEqual(["memory.recall"]);
    expect(names(guarded({ grant: ["chats.list"] }))).toEqual(["chats.list", "discord.messages", "memory.recall"]);
  });

  it("queues an ask with what the caller was saying, so the prompt reads as a sentence", async () => {
    registry.register({ name: "danger", description: "d", inputSchema: { type: "object" } }, () => "done", { floor: "risky" });
    const tools = guarded({ conversationId: "c1", whyFor: (id) => (id === "c1" ? "I'll clear the build folder so the rebuild is clean. " : undefined), waitForApproval: false });
    await tools.execute("danger", { x: 1 });
    expect(approvals.pending()[0]?.why).toBe("I'll clear the build folder so the rebuild is clean.");
  });

  it("runs a chat's actions in the owner's Chrome without asking when the owner set it so, and nothing else", async () => {
    for (const name of ["browser.act", "browser.eval", "files.rm"]) {
      registry.register({ name, description: name, inputSchema: { type: "object" } }, () => "done", { floor: "risky" });
    }
    const yours = { browser: { prefix: "browser.", site: "shop.example", strict: ["browser.eval"], yours: true } };
    const tools = guarded({
      conversationId: "c1",
      waitForApproval: false,
      permissionContext: (tool) => (tool.startsWith("browser.") ? yours : undefined),
      autoApproves: (tool, context) => actsInYourChrome(tool, context),
    });
    expect((await tools.execute("browser.act", { steps: [] })).content).toBe("done");
    expect(audit.recent(5)[0]).toMatchObject({ tool: "browser.act", riskTier: "risky" });
    // Running script in the page asks however the chat is set, and so does everything outside the owner's Chrome.
    expect((await tools.execute("browser.eval", { js: "1" })).content).toMatch(/Queued for approval/);
    expect((await tools.execute("files.rm", { path: "a" })).content).toMatch(/Queued for approval/);
    expect(approvals.pending().map((a) => a.tool)).toEqual(["browser.eval", "files.rm"]);
    // KOS's own browser is not the owner's Chrome.
    expect(actsInYourChrome("browser.act", { browser: { prefix: "browser.", strict: [] } })).toBe(false);
  });

  it("runs a risky call the owner already decided, without asking", async () => {
    /*
     * 96 of 97 approvals on a real workspace were granted. A decision made
     * for this shape is not asked again: the call runs, audited as risky,
     * and nothing reaches the queue. A shape with no rule still queues.
     */
    registry.register({ name: "danger", description: "d", inputSchema: { type: "object" } }, () => "done", { floor: "risky" });
    const permissions = new PermissionStore(ws.db);
    const tools = guarded({ permissions, projectSlug: () => undefined, waitForApproval: false });

    const asked = await tools.execute("danger", { x: 1 });
    expect(asked.content).toMatch(/Queued for approval/);
    expect(approvals.pending()).toHaveLength(1);

    permissions.add({ tool: "danger", scope: null, project: null });
    const ran = await tools.execute("danger", { x: 1 });
    expect(ran.content).toBe("done");
    expect(approvals.pending()).toHaveLength(1);
    expect(audit.recent(1)[0]).toMatchObject({ tool: "danger", riskTier: "risky" });
  });

  it("trusts a browser action by the site its tab is on, pictures what it asks about, and never trusts script", async () => {
    registry.register({ name: "browser.act", description: "d", inputSchema: { type: "object" } }, () => "clicked", { floor: "risky" });
    registry.register({ name: "browser.eval", description: "d", inputSchema: { type: "object" } }, () => "ran", { floor: "risky" });
    const permissions = new PermissionStore(ws.db);
    const context = { browser: { prefix: "browser.", site: "shop.example", strict: ["browser.eval"] } };
    const tools = guarded({
      permissions,
      projectSlug: () => undefined,
      waitForApproval: false,
      permissionContext: (tool) => (tool.startsWith("browser.") ? context : undefined),
      pictureFor: async (tool) => (tool.startsWith("browser.") ? "UElD" : undefined),
    });

    const asked = await tools.execute("browser.act", { steps: [{ click: "@e5" }] });
    expect(asked.content).toMatch(/Queued for approval/);
    const queued = approvals.pending()[0]!;
    expect(queued).toMatchObject({ reason: "on shop.example", rule: { tool: "browser.*", scope: "site:shop.example", project: null }, picture: true });
    expect(approvals.pictureOf(queued.id)).toBe("UElD");

    // The owner's yes-and-remember: every browser action on that site runs.
    permissions.add(queued.rule!);
    expect((await tools.execute("browser.act", { steps: [{ click: "@e9" }] })).content).toBe("clicked");
    // Script in the page still asks.
    expect((await tools.execute("browser.eval", { code: "1" })).content).toMatch(/Queued for approval/);
    expect(approvals.pending().at(-1)?.rule).toBeNull();
  });

  it("tells a handler which conversation is calling, per call, under concurrency", async () => {
    /*
     * Turns run one lane per conversation, so two toolboxes execute at once.
     * A handler that asks who is calling must get its own conversation, not
     * whichever turn happened to start last: an aside running beside an
     * orchestrator turn once took credit for that turn's congregation roster.
     */
    registry.register(
      { name: "whoami", description: "w", inputSchema: { type: "object" } },
      async () => {
        await new Promise((r) => setTimeout(r, 5));
        return caller.getStore() ?? "nobody";
      },
      { floor: "safe" },
    );
    const a = guarded({ conversationId: "aside:primary" });
    const b = guarded({ conversationId: "orchestrator:owner" });
    const anon = guarded();

    const [ra, rb, rn] = await Promise.all([
      a.execute("whoami", {}),
      b.execute("whoami", {}),
      anon.execute("whoami", {}),
    ]);
    expect(ra.content).toBe("aside:primary");
    expect(rb.content).toBe("orchestrator:owner");
    expect(rn.content).toBe("nobody");
    // Nothing leaks out of a call: outside any handler there is no caller.
    expect(caller.getStore()).toBeUndefined();
  });

  it("runs a safe tool, injecting secrets and auditing", async () => {
    let seen: string | undefined;
    registry.register(
      { name: "echo", description: "e", inputSchema: { type: "object" } },
      (input) => {
        seen = String(input.key);
        return "ok";
      },
    );
    const res = await guarded().execute("echo", { key: "{{secret:openai}}" });
    expect(res.isError).toBe(false);
    expect(seen).toBe("sk-real"); // injected before execution
    const [entry] = audit.recent();
    expect(entry?.tool).toBe("echo");
    expect(entry?.args).toContain("{{secret:openai}}"); // audit stays redacted
  });

  it("refuses a call its rule refuses, before the owner is asked", async () => {
    const ran: string[] = [];
    registry.register(
      { name: "open", description: "", inputSchema: { type: "object", properties: {} } },
      (input) => {
        ran.push(String(input["path"]));
        return "opened";
      },
      { ...RISKY, refuse: (input) => (input["path"] === "kos.sqlite" ? "not that file: read it through its tool" : false) },
    );
    const refused = await guarded().execute("open", { path: "kos.sqlite" });
    expect(refused).toEqual({ content: "not that file: read it through its tool", isError: true });
    expect(approvals.pending()).toEqual([]);
    expect(ran).toEqual([]);
    // Anything else is judged as before: risky, so it asks.
    const asked = guarded().execute("open", { path: "notes.md" });
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
    approvals.deny(approvals.pending()[0]!.id, "owner");
    await asked;
  });

  it("holds a risky call until the owner decides, then runs it", async () => {
    let ran = false;
    registry.register(
      { name: "danger", description: "d", inputSchema: { type: "object" } },
      () => {
        ran = true;
        return "ran";
      },
      RISKY,
    );

    // The call does not return while it waits: the turn is suspended inside
    // it. Returning early is what used to end the turn and start a second one
    // on approval, which cleared the live view and ran the tool under a new
    // bubble.
    const call = guarded().execute("danger", {});
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
    expect(ran).toBe(false);

    approvals.approve(approvals.pending()[0]!.id, "owner");
    const res = await call;

    expect(ran).toBe(true);
    expect(res.content).toBe("ran");
    expect(res.isError).toBeFalsy();
  });

  it("does not run it when the owner says no", async () => {
    registry.register(
      { name: "danger", description: "d", inputSchema: { type: "object" } },
      () => "ran",
      RISKY,
    );
    const call = guarded().execute("danger", {});
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));

    approvals.deny(approvals.pending()[0]!.id, "owner");
    const res = await call;

    // Told plainly, and told not to try again: a refusal the model reads as a
    // transient failure is a refusal it will work around.
    expect(res.content).toMatch(/not approved/);
    expect(res.content).toMatch(/Do not try it again/);
  });

  it("treats silence as a refusal rather than waiting forever", async () => {
    registry.register(
      { name: "danger", description: "d", inputSchema: { type: "object" } },
      () => "ran",
      RISKY,
    );
    // A turn that waits forever holds its conversation's queue forever.
    const res = await guarded({ approvalTimeoutMs: 10 }).execute("danger", {});
    expect(res.content).toMatch(/not approved/);
    expect(res.content).toMatch(/Nobody decided within the wait/);
    // The ask lapsed with the wait rather than lingering in the inbox.
    expect(approvals.pending()).toHaveLength(0);
  });


  describe("when the owner presses Stop", () => {
    it("answers a running call at once, and tells the tool so it can end what it started", async () => {
      let told: AbortSignal | undefined;
      registry.register({ name: "slow", description: "s", inputSchema: { type: "object" } }, () => {
        told = turnStop.getStore();
        return new Promise<string>(() => undefined);
      });
      const stop = new AbortController();
      const call = guarded({ signal: stop.signal }).execute("slow", {});
      await vi.waitFor(() => expect(told).toBeDefined());
      stop.abort();
      expect(await call).toEqual({ content: STOPPED_RESULT, isError: true });
      expect(told?.aborted).toBe(true);
    });

    it("lapses the ask a call is waiting on, and nothing runs", async () => {
      let ran = false;
      registry.register({ name: "danger", description: "d", inputSchema: { type: "object" } }, () => {
        ran = true;
        return "ran";
      }, RISKY);
      const stop = new AbortController();
      const call = guarded({ signal: stop.signal }).execute("danger", {});
      await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
      const id = approvals.pending()[0]!.id;
      stop.abort();
      expect((await call).content).toBe(STOPPED_RESULT);
      // Settled, not left in the inbox for a yes that would run it for nobody.
      expect(approvals.get(id)).toMatchObject({ status: "expired", decidedBy: "stopped" });
      expect(approvals.pending()).toHaveLength(0);
      expect(ran).toBe(false);
    });

    it("tells what a stopped call did once it ends, and nothing for an ask that lapsed", async () => {
      let finish: ((v: string) => void) | undefined;
      registry.register({ name: "slow", description: "s", inputSchema: { type: "object" } }, () => new Promise<string>((r) => (finish = r)));
      registry.register({ name: "danger", description: "d", inputSchema: { type: "object" } }, () => "ran", RISKY);
      const finished = vi.fn();
      const stop = new AbortController();
      const tools = guarded({ signal: stop.signal, onFinishedAfterStop: finished });
      const call = tools.execute("slow", {});
      const ask = tools.execute("danger", {});
      await vi.waitFor(() => expect(finish).toBeDefined());
      await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
      stop.abort();
      expect((await call).content).toBe(STOPPED_RESULT);
      expect((await ask).content).toBe(STOPPED_RESULT);
      expect(finished).not.toHaveBeenCalled();
      finish!("sent");
      await vi.waitFor(() => expect(finished).toHaveBeenCalledWith("slow", expect.objectContaining({ content: "sent" })));
      expect(finished).toHaveBeenCalledTimes(1);
      expect(finishedAfterStop("slow", { content: "sent", isError: false })).toBe("After Stop, slow finished and succeeded: sent");
      expect(STOPPED_RESULT).toMatch(/may still have run/);
    });

    it("posts no ask when the stop lands while its picture is taken", async () => {
      registry.register({ name: "danger", description: "d", inputSchema: { type: "object" } }, () => "ran", RISKY);
      const stop = new AbortController();
      const queued = vi.fn();
      const pictureFor = async (): Promise<string> => {
        stop.abort();
        return "SU1H";
      };
      expect((await guarded({ signal: stop.signal, pictureFor, onQueued: queued }).execute("danger", {})).content).toBe(STOPPED_RESULT);
      expect(approvals.pending()).toHaveLength(0);
      expect(queued).not.toHaveBeenCalled();
    });

    it("starts no call after the stop", async () => {
      let ran = false;
      registry.register({ name: "probe", description: "p", inputSchema: { type: "object" } }, () => {
        ran = true;
        return "ran";
      });
      const stop = new AbortController();
      stop.abort();
      expect((await guarded({ signal: stop.signal }).execute("probe", {})).content).toBe(STOPPED_RESULT);
      expect(ran).toBe(false);
    });

    it("runs nothing when the stop lands while its session is being asked for, even once the owner allows it", async () => {
      let ran = false;
      registry.register({ name: "probe", description: "p", inputSchema: { type: "object" } }, () => {
        ran = true;
        return "ran";
      });
      let allow: (() => void) | undefined;
      const asked = new Promise<undefined>((resolve) => (allow = () => resolve(undefined)));
      const stop = new AbortController();
      const tools = guarded({ signal: stop.signal, prepare: () => asked });
      const answered = tools.execute("probe", {});
      await Promise.resolve();
      stop.abort();
      expect((await answered).content).toBe(STOPPED_RESULT);
      // The owner presses Allow after Stop: the call that waited on it still does nothing.
      allow!();
      await new Promise((r) => setTimeout(r, 5));
      expect(ran).toBe(false);
      expect(audit.recent(10)).toEqual([]);
    });

    it("leaves what the owner said meanwhile for a turn of its own", async () => {
      let finish: ((v: string) => void) | undefined;
      registry.register({ name: "slow", description: "s", inputSchema: { type: "object" } }, () => new Promise<string>((r) => (finish = r)));
      const heard = vi.fn(() => "\nOwner: and then this");
      const stop = new AbortController();
      const call = guarded({ signal: stop.signal, heard }).execute("slow", {});
      await vi.waitFor(() => expect(finish).toBeDefined());
      stop.abort();
      finish!("done");
      expect((await call).content).toBe(STOPPED_RESULT);
      expect(heard).not.toHaveBeenCalled();
    });
  });

  it("offers a project's tools only inside that project", async () => {
    // A module for the pantry project: its tool exists in pantry's
    // conversations and nowhere else, withheld rather than hidden.
    registry.register(
      { name: "mcp.shelf.count", description: "count", inputSchema: { type: "object", properties: {} } },
      () => "3",
      { floor: "safe" },
      { tags: ["project:pantry"] },
    );
    const inside = guarded({ projectSlug: () => "pantry" });
    const outside = guarded({ projectSlug: () => "garden" });
    const root = guarded({ projectSlug: () => undefined });
    expect(inside.defs().map((d) => d.name)).toContain("mcp.shelf.count");
    expect(outside.defs().map((d) => d.name)).not.toContain("mcp.shelf.count");
    expect(root.defs().map((d) => d.name)).not.toContain("mcp.shelf.count");
    expect((await outside.execute("mcp.shelf.count", {})).isError).toBe(true);
    expect((await inside.execute("mcp.shelf.count", {})).content).toBe("3");
  });
});


describe("repeated calls", () => {
  let root: string;
  let ws: Workspace;
  let tools: GuardedTools;
  let calls: number;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-repeat-"));
    ws = Workspace.open(root);
    calls = 0;
    const registry = new ToolRegistry();
    registry.register(
      {
        name: "peek",
        description: "read something",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      },
      () => {
        calls += 1;
        return "same answer";
      },
      { floor: "safe" },
    );
    tools = new GuardedTools({
      registry,
      secrets: new SecretsRegistry(),
      audit: new AuditLog(ws.db),
      approvals: new ApprovalQueue(ws.db),
    });
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses a third identical call and says why", async () => {
    // A scoped agent spent its whole step budget calling one tool with one set
    // of arguments over and over, and the turn ended with no answer at all.
    expect((await tools.execute("peek", { q: "x" })).isError).toBe(false);
    expect((await tools.execute("peek", { q: "x" })).isError).toBe(false);
    const third = await tools.execute("peek", { q: "x" });
    expect(third.isError).toBe(true);
    expect(third.content).toMatch(/already called peek/);
    expect(calls).toBe(2);
  });

  it("counts arguments, not just the tool", async () => {
    await tools.execute("peek", { q: "x" });
    await tools.execute("peek", { q: "x" });
    const other = await tools.execute("peek", { q: "y" });
    expect(other.isError).toBe(false);
    expect(other.content).toBe("same answer");
  });

  it("starts fresh for the next turn", async () => {
    await tools.execute("peek", { q: "x" });
    await tools.execute("peek", { q: "x" });
    expect((await tools.execute("peek", { q: "x" })).isError).toBe(true);
    // A GuardedTools instance is built per turn, so a new one forgets.
    const next = new GuardedTools({
      registry: (tools as unknown as { deps: { registry: ToolRegistry } }).deps
        .registry,
      secrets: new SecretsRegistry(),
      audit: new AuditLog(ws.db),
      approvals: new ApprovalQueue(ws.db),
    });
    expect((await next.execute("peek", { q: "x" })).isError).toBe(false);
  });
});
