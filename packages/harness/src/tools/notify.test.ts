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
  parseTarget,
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
    notify?: (payload: NotifyPayload) => Promise<void>,
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
    expect(parseTarget("reply")).toEqual({ kind: "reply" });
    expect(registry.classify("notify", { text: "x", to: "reply" }).tier).toBe(
      "safe",
    );
  });

  it("does not tell the model it sent something it is holding", async () => {
    /*
     * The failure this exists for: reply returned "sent", so the model
     * believed the message had gone, had nothing left to say, and finished
     * with "I do not have anything to add to that". The card then arrived
     * under a sentence saying there was nothing to add.
     */
    const registry = await load(async () => undefined);
    const res = await registry.execute("notify", {
      text: "",
      to: "reply",
      card: { title: "Status" },
    });
    expect(res.isError).toBe(false);
    expect(res.content).toContain("Nothing has been sent yet");
    expect(res.content).toContain("Write that answer now");
    expect(res.content).not.toMatch(/^sent/);
  });

  it("takes a bare string as a button label", async () => {
    const sent: NotifyPayload[] = [];
    let minted = 0;
    const registry = await load(
      async (p) => {
        sent.push(p);
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
