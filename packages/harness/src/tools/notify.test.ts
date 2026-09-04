import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
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
  ): Promise<ToolRegistry> {
    const registry = new ToolRegistry();
    const ctx = toolRegistryContext(registry, {
      workspace: ws,
      db: ws.db,
      secrets: new SecretsRegistry(),
      ...(notify ? { notify } : {}),
    });
    await new ModuleLoader(ctx).load([
      routePress ? createNotifyModule({ routePress }) : notifyModule,
    ]);
    return registry;
  }

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
  });

  it("errors when no channel is wired", async () => {
    const registry = await load();
    const res = await registry.execute("notify", { text: "x" });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/no notify channel/);
  });
});
