import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { caller, guested, ownership, scheduled, tainting } from "../kernel/caller.js";
import { Taint } from "../risk/taint.js";
import { ModuleLoader, toolRegistryContext } from "../modules/loader.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Workspace } from "../store/workspace.js";
import {
  createNotifyModule,
  noticeText,
  notifyModule,
  describeSend,
  parseTarget,
  sendsElsewhere,
  type NotifyPayload,
} from "./notify.js";

describe("notifyModule", () => {
  let root: string;
  let ws: Workspace;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-notify-"));
    ws = Workspace.open(root);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function load(
    notify?: (payload: NotifyPayload) => Promise<string | undefined>,
    routePress?: (b: { id: string; label: string }, replyTo?: string) => string,
    projectOf?: (conversationId: string) => string | undefined,
  ): Promise<ToolRegistry> {
    const registry = new ToolRegistry();
    const ctx = toolRegistryContext(registry, {
      workspace: ws,
      db: ws.db,
      secrets: new SecretsRegistry(),
      ...(notify ? { notify } : {}),
    });
    await new ModuleLoader(ctx).load([
      routePress ? createNotifyModule({ routePress, ...(projectOf ? { projectOf } : {}) }) : notifyModule,
    ]);
    return registry;
  }

  it("sends nothing a surface fetches from a turn that read outside text: no link or picture on the card, no previews", async () => {
    const sent: NotifyPayload[] = [];
    const registry = await load(async (p) => {
      sent.push(p);
      return undefined;
    });
    const card = { title: "Hi", imageUrl: "https://attacker.example/x.png?d=memory", thumbnailUrl: "https://attacker.example/t.png", url: "https://attacker.example/" };
    await tainting.run(new Taint([{ kind: "page", where: "attacker.example" }]), () => registry.execute("notify", { text: "done", card }));
    await registry.execute("notify", { text: "done", card });
    expect(sent[0]).toMatchObject({ card: { title: "Hi" }, noPreviews: true });
    expect(sent[0]!.card).toEqual({ title: "Hi" });
    expect(sent[1]).toMatchObject({ card });
    expect(sent[1]!.noPreviews).toBeUndefined();
  });

  it("sends a scheduled run's unaddressed message to the job's place, and an addressed one where it says", async () => {
    const sent: NotifyPayload[] = [];
    const registry = await load(async (p) => {
      sent.push(p);
      return undefined;
    });
    const inRun = (input: Record<string, unknown>) => caller.run("cron:7", () => scheduled.run(7, () => registry.execute("notify", input)));
    await inRun({ text: "digest" });
    await inRun({ text: "ping me", to: "owner" });
    await inRun({ text: "dm me", to: "discord" });
    // The owner's own turn in the same thread is not a run: it reaches the owner.
    await caller.run("cron:7", () => registry.execute("notify", { text: "asked" }));
    expect(sent[0]?.job).toBe(7);
    expect(sent.map((p) => [p.text, p.place ?? null, p.target])).toEqual([
      ["digest", "cron:7", { kind: "owner" }],
      ["ping me", null, { kind: "owner" }],
      ["dm me", null, { surface: "discord", kind: "owner" }],
      ["asked", null, { kind: "owner" }],
    ]);
  });

  it("ends a scheduled run quietly, posting nothing, and refuses quiet anywhere else or beside a message", async () => {
    const sent: NotifyPayload[] = [];
    const registry = await load(async (p) => {
      sent.push(p);
      return undefined;
    });
    const inRun = (input: Record<string, unknown>) => caller.run("cron:7", () => scheduled.run(7, () => registry.execute("notify", input)));

    const quiet = await inRun({ quiet: "nothing new above the bar." });
    expect(quiet).toEqual({ content: "Posted nothing: nothing new above the bar. The run is recorded as choosing not to post.", isError: false });

    const outside = await caller.run("chat-1", () => registry.execute("notify", { quiet: "nothing new" }));
    expect(outside.isError).toBe(true);
    expect(outside.content).toMatch(/quiet is for a scheduled run/);

    const withText = await inRun({ quiet: "nothing new", text: "but here it is" });
    expect(withText.isError).toBe(true);
    expect(withText.content).toMatch(/quiet posts nothing, so it takes no text/);
    expect((await inRun({ quiet: "nothing new", to: "channel:99" })).content).toMatch(/takes no to/);
    expect((await inRun({ quiet: "  " })).content).toMatch(/quiet takes why nothing is posted/);
    expect(sent).toEqual([]);

    // Sending nothing, it asks nothing, wherever it names.
    expect(registry.classify("notify", { quiet: "nothing new", to: "channel:99" }).tier).toBe("safe");
  });

  it("sends via the wired channel and is safe-tier", async () => {
    const sent: NotifyPayload[] = [];
    const registry = await load(async (p) => {
      sent.push(p);
      return undefined;
    });
    const res = await registry.execute("notify", { text: "hello" });
    expect(res.isError).toBe(false);
    expect(sent).toEqual([{ text: "hello", target: { kind: "owner" } }]);
    expect(registry.classify("notify", { text: "x" }).tier).toBe("safe");
    // A message anywhere but to the owner is beyond a chat's Auto, by the same line that makes it ask.
    expect(registry.classify("notify", { text: "x", to: "channel:99" }).beyondAuto).toBe("messages someone besides you");
    expect(registry.classify("notify", { text: "x", to: "reply" }).beyondAuto).toBe(sendsElsewhere({ to: "reply" }) ? "messages someone besides you" : undefined);
  });

  it("asks first before speaking anywhere but to the owner", () => {
    // Messaging the owner is the whole point of the tool. Posting in a channel
    // is KOS talking in a place the owner did not pick for it.
    const registry = new ToolRegistry();
    void registry;
    expect(parseTarget("channel:123")).toEqual({ kind: "channel", id: "123" });
    expect(parseTarget(undefined)).toEqual({ kind: "owner" });
    expect(() => parseTarget("123")).toThrow(/unrecognised destination/);
  });

  it("escalates a message aimed somewhere else", async () => {
    const registry = await load(async () => undefined);
    expect(registry.classify("notify", { text: "x" }).tier).toBe("safe");
    expect(
      registry.classify("notify", { text: "x", to: "channel:99" }).tier,
    ).toBe("risky");
  });

  it("carries a card and mints a token for each button", async () => {
    const sent: NotifyPayload[] = [];
    let minted = 0;
    const registry = await load(
      async (p) => {
        sent.push(p);
        return undefined;
      },
      () => `tok${++minted}`,
    );
    const res = await registry.execute("notify", {
      text: "Deploy?",
      card: { title: "Ready", fields: [{ name: "Target", value: "iad", inline: true }] },
      buttons: [
        { label: "Ship it", id: "ship", style: "success" },
        { label: "Docs", url: "https://example.com" },
      ],
    });
    expect(res.isError).toBe(false);
    expect(sent[0]?.card?.fields).toEqual([
      { name: "Target", value: "iad", inline: true },
    ]);
    // A link button comes back from nothing, so it needs no token.
    expect(sent[0]?.buttons?.map((b) => b.token)).toEqual(["tok1", undefined]);
  });

  it("sends a press to another chat only from the owner's own turn", async () => {
    const sent: NotifyPayload[] = [];
    const routed: (string | undefined)[] = [];
    const registry = await load(
      async (p) => {
        sent.push(p);
        return undefined;
      },
      (_b, replyTo) => {
        routed.push(replyTo);
        return "tok";
      },
    );
    const call = (replyTo: string | undefined, owner: boolean) =>
      caller.run("room", () =>
        ownership.run(owner, () =>
          registry.execute("notify", { text: "pick", buttons: [{ label: "Go" }], ...(replyTo ? { replyTo } : {}) }),
        ),
      );
    // A guest's or a schedule's turn naming the owner's private chat: refused, nothing minted or sent.
    const planted = await call("private", false);
    expect(planted.isError).toBe(true);
    expect(planted.content).toMatch(/only the owner's own turn/);
    expect(routed).toEqual([]);
    expect(sent).toEqual([]);
    // Its own chat, said or left out, is still its own.
    expect((await call("room", false)).isError).toBe(false);
    expect((await call(undefined, false)).isError).toBe(false);
    // The owner's own turn sends a press wherever they say.
    expect((await call("private", true)).isError).toBe(false);
    expect(routed).toEqual(["room", undefined, "private"]);
    // Outside any turn nobody said it was the owner.
    expect((await registry.execute("notify", { text: "pick", buttons: [{ label: "Go" }], replyTo: "private" })).isError).toBe(true);
  });

  it("sends a press from a turn not the owner's to another chat of its own project, and nowhere else", async () => {
    const projects: Record<string, string> = { "cron:1": "a", "project:a": "a", "discord:thread:t1": "a", "project:b": "b" };
    const routed: (string | undefined)[] = [];
    const registry = await load(
      async () => undefined,
      (_b, replyTo) => {
        routed.push(replyTo);
        return "tok";
      },
      (id) => projects[id],
    );
    const from = (chat: string, replyTo: string) =>
      caller.run(chat, () => ownership.run(false, () => registry.execute("notify", { text: "hint?", buttons: [{ label: "Show hint" }], replyTo })));
    // A project's schedule, its button reaching the project's own chat.
    expect((await from("cron:1", "project:a")).isError).toBe(false);
    // A guest in the project's room, naming another chat of the same project.
    expect((await from("project:a", "discord:thread:t1")).isError).toBe(false);
    expect(routed).toEqual(["project:a", "discord:thread:t1"]);
    // Another project, the root or a private chat, a blob's thread, a chat that is not there: refused.
    for (const to of ["project:b", "orchestrator:owner", "private", "agent:noter", "nowhere"]) {
      const res = await from("cron:1", to);
      expect(res.isError, to).toBe(true);
      expect(res.content).toMatch(/only the owner's own turn/);
    }
    // A caller with no project reaches its own chat alone.
    expect((await from("agent:noter", "agent:noter")).isError).toBe(false);
    expect((await from("agent:noter", "project:a")).isError).toBe(true);
    expect(routed).toEqual(["project:a", "discord:thread:t1", "agent:noter"]);
  });

  it("refuses a button on a surface that cannot take one back", async () => {
    const registry = await load(async () => undefined);
    const res = await registry.execute("notify", {
      text: "pick",
      buttons: [{ label: "Yes", id: "yes" }],
    });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/cannot take a button back/);
  });

  it("does not ask permission to shape its own answer", async () => {
    // Answering is not speaking somewhere new. If a card cost an approval and
    // a paragraph cost nothing, the agent would learn never to use one.
    const registry = await load(async () => undefined);
    expect(registry.classify("notify", { text: "x", asReply: true }).tier).toBe(
      "safe",
    );
  });

  it("reads the surface out of a destination, then where on it", () => {
    // "to" answers which surface and where on it. Both optional, and the
    // common case is neither.
    expect(parseTarget(undefined)).toEqual({ kind: "owner" });
    expect(parseTarget("discord")).toEqual({ surface: "discord", kind: "owner" });
    expect(parseTarget("discord:channel:123")).toEqual({
      surface: "discord",
      kind: "channel",
      id: "123",
    });
    // A destination with no surface still works: whichever one is wired.
    expect(parseTarget("channel:123")).toEqual({ kind: "channel", id: "123" });
    expect(parseTarget("user:456")).toEqual({ kind: "user", id: "456" });
  });

  it("says what reply means rather than hunting for a surface called reply", () => {
    // Models invent it, and it used to name a real thing here. Falling
    // through to the surface check answered "no reply surface here", which
    // reads as a broken bridge rather than a word that means nothing.
    expect(() => parseTarget("reply")).toThrow(/not a destination/);
    expect(() => parseTarget("reply")).toThrow(/back to whoever pressed/);
    expect(() => parseTarget("interaction")).toThrow(/not a destination/);
  });

  it("refuses a destination it would have to guess at", () => {
    // A user id and a channel id are indistinguishable, and the wrong guess
    // sends in public what was meant to be private.
    expect(() => parseTarget("123456789")).toThrow(/unrecognised destination/);
    expect(() => parseTarget("discord:channel")).toThrow(/needs an id/);
    expect(() => parseTarget("channel")).toThrow(/needs an id/);
  });

  it("asks before a channel on any surface, and never for the owner", () => {
    expect(sendsElsewhere({ to: "discord" })).toBe(false);
    expect(sendsElsewhere({ to: "owner" })).toBe(false);
    expect(sendsElsewhere({})).toBe(false);
    // Which surface is not the question; whom is.
    expect(sendsElsewhere({ to: "discord:channel:1" })).toBe(true);
    expect(sendsElsewhere({ to: "channel:1" })).toBe(true);
    expect(sendsElsewhere({ to: "user:1" })).toBe(true);
  });

  it("takes a bare string as a button label", async () => {
    const sent: NotifyPayload[] = [];
    let minted = 0;
    const registry = await load(
      async (p) => {
        sent.push(p);
        return undefined;
      },
      () => `tok${++minted}`,
    );
    // What an agent writes when it is thinking about the reader rather than
    // the schema. Dropped, it left text promising buttons that were not there.
    await registry.execute("notify", {
      text: "pick one",
      buttons: ["Say hi", "Show the budget"],
    });
    expect(sent[0]?.buttons?.map((b) => b.label)).toEqual([
      "Say hi",
      "Show the budget",
    ]);
    expect(sent[0]?.buttons?.[0]?.token).toBe("tok1");
  });

  it("says which card keys it threw away", async () => {
    const registry = await load(async () => undefined);
    // Fields written as keys of their own produced a title and no sign that
    // everything else had gone.
    const res = await registry.execute("notify", {
      text: "report",
      card: { title: "Systems", Status: "green", Timezone: "UTC" },
    });
    expect(res.content).toContain("Ignored on the card: Status, Timezone");
    expect(res.content).toContain("fields: [{name, value}]");
  });

  it("says where it went and what comes back, not just sent", async () => {
    /*
     * "sent" was the whole result: nothing about where it went, what it
     * carried, or what to expect. An agent that cannot tell a delivered
     * message from a held one guesses, and it guessed wrong the first time
     * anyone watched.
     */
    const registry = await load(
      async () => undefined,
      () => "tok1",
    );
    const res = await registry.execute("notify", {
      text: "pick one",
      to: "discord",
      buttons: [
        { label: "Add a note", modal: { title: "Note", fields: [{ id: "n", label: "N" }] } },
        { label: "Just me", ephemeral: true },
        { label: "Docs", url: "https://example.com" },
      ],
    });
    expect(res.isError).toBe(false);
    expect(res.content).toContain("Sent to the owner on discord");
    expect(res.content).toContain("3 buttons");
    expect(res.content).toContain("Presses arrive as a message");
    expect(res.content).toContain('Opens a form: "Add a note"');
    expect(res.content).toContain('Answers privately: "Just me"');
    expect(res.content).toContain("Link buttons send nothing back");
  });

  it("does not describe a card by the fields it does not have", () => {
    const plain = describeSend({
      target: { kind: "owner" },
      text: "hi",
      card: { title: "Status", body: "green" },
      buttons: [],
      stray: [],
    });
    expect(plain).toContain("a card");
    expect(plain).not.toContain("0 fields");
  });

  it("says what will not fit before the surface drops it", () => {
    const many = describeSend({
      target: { kind: "owner" },
      text: "hi",
      buttons: [
        ...Array.from({ length: 30 }, (_, i) => ({ label: `b${i}` })),
        {
          label: "Long form",
          modal: {
            title: "t",
            fields: Array.from({ length: 8 }, (_, i) => ({ id: `f${i}`, label: `F${i}` })),
          },
        },
      ],
      stray: [],
    });
    // Trimming happens in the adapter, after this call has returned, so an
    // agent only ever saw the result: a form missing its last boxes.
    expect(many).toContain("Only the first 25 buttons are shown");
    expect(many).toContain('form on "Long form" has 8 boxes');
  });

  it("reads a card back as prose where there is no card", () => {
    const text = noticeText({
      text: "Heads up",
      target: { kind: "owner" },
      card: { title: "Backup", body: "done", fields: [{ name: "Size", value: "2MB" }] },
    });
    expect(text).toContain("Heads up");
    expect(text).toContain("**Backup**");
    expect(text).toContain("Size: 2MB");
    // A blob's notice is the blob's, on the dashboard as on a surface.
    expect(noticeText({ text: "Heads up", target: { kind: "owner" }, from: { name: "Recap" } })).toBe("Recap: Heads up");
  });

  it("errors when no channel is wired", async () => {
    const registry = await load();
    const res = await registry.execute("notify", { text: "x" });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/no notify channel/);
  });

  describe("a place only the owner reads", () => {
    async function withAudience(ownerAlone: ((target: { kind: string; id?: string }) => boolean) | undefined): Promise<ToolRegistry> {
      const registry = new ToolRegistry();
      const ctx = toolRegistryContext(registry, { workspace: ws, db: ws.db, secrets: new SecretsRegistry() });
      await new ModuleLoader(ctx).load([createNotifyModule(ownerAlone ? { ownerAlone } : {})]);
      return registry;
    }

    it("posts there without asking, as to the owner", async () => {
      const registry = await withAudience((t) => t.kind === "channel" && t.id === "own");
      expect(registry.classify("notify", { text: "x", to: "discord:channel:own" }).tier).toBe("safe");
      expect(registry.classify("notify", { text: "x", to: "channel:own" }).tier).toBe("safe");
      expect(scheduled.run(7, () => registry.classify("notify", { text: "x", to: "discord:channel:own" })).tier).toBe("safe");
    });

    it("still asks where others read, for a person, and when a guest's words are behind it", async () => {
      const registry = await withAudience((t) => t.kind === "channel" && t.id === "own");
      expect(registry.classify("notify", { text: "x", to: "discord:channel:pub" }).tier).toBe("risky");
      expect(registry.classify("notify", { text: "x", to: "discord:user:own" }).tier).toBe("risky");
      expect(guested.run({ project: "school", chat: "room" }, () => registry.classify("notify", { text: "x", to: "discord:channel:own" })).tier).toBe("risky");
    });

    it("asks when who reads it cannot be known: no server, or none wired", async () => {
      expect((await withAudience(() => false)).classify("notify", { text: "x", to: "discord:channel:own" }).tier).toBe("risky");
      expect((await withAudience(undefined)).classify("notify", { text: "x", to: "discord:channel:own" }).tier).toBe("risky");
    });
  });
});
