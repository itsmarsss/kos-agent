import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UNCHANGED } from "@kos/shared";
import { afterEach, describe, expect, it } from "vitest";

import type { Inference } from "../agent/loop.js";
import type { GenerateRequest, ModelResponse } from "../models/types.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import type { BrowserElsewhere } from "../tools/browser.js";
import { ownWordsOn } from "./caller.js";
import { Kernel } from "./kernel.js";

/**
 * The side panel's chat browses in the owner's Chrome, never in KOS's own:
 * its first browser call starts the session there before the call is judged,
 * and a session that cannot start refuses the call instead of running it in
 * KOS's browser.
 */

const ended = (text: string): ModelResponse => ({ content: [{ type: "text", text }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" });

/** A model that calls one tool, then answers; every request it was sent, kept. */
function oneCall(tool: string, input: Record<string, unknown>): { inference: Inference; sent: GenerateRequest[] } {
  const sent: GenerateRequest[] = [];
  let first = true;
  return {
    sent,
    inference: {
      async generate(_t, req) {
        sent.push(req);
        if (!first) return ended("done");
        first = false;
        return { content: [{ type: "tool_use", id: "t1", name: tool, input }], stopReason: "tool_use", usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" };
      },
    },
  };
}

/** The owner's Chrome as the kernel sees it: a chat it claims, a session that starts or does not. */
function ownerChrome(opts: { starts: boolean }): BrowserElsewhere & { ensured: string[] } {
  let live = false;
  const ensured: string[] = [];
  return {
    ensured,
    active: () => live,
    claims: () => true,
    ensure: async (c) => {
      ensured.push(c);
      if (!opts.starts) throw new Error("The owner did not allow the session in their Chrome.");
      live = true;
    },
    tab: async () => {
      throw new Error("no tab in this test");
    },
    tabs: () => [{ id: "77", title: "Cart", url: "https://shop.example/cart", current: true }],
    tabsOf: () => ["77"],
    useTab: async () => undefined,
    newTab: async () => "88",
    siteOf: () => "shop.example",
    picture: async () => undefined,
    describe: () => "the owner's Chrome (Chrome on macOS)",
  };
}

describe("a browser call from the side panel's chat", () => {
  let root: string;
  let kernel: Kernel;

  afterEach(() => {
    kernel?.close();
    rmSync(root, { recursive: true, force: true });
  });

  const boot = (inference: Inference): Promise<Kernel> => {
    root = mkdtempSync(join(tmpdir(), "kos-elsewhere-"));
    return Kernel.boot({ rootDir: root, secrets: new SecretsRegistry(), inference, profileOverrides: { name: "Kenny", timezone: "UTC" } });
  };

  const resultOf = (sent: GenerateRequest[]): string => JSON.stringify(sent.at(-1)?.messages.at(-1));

  it("starts the session in the owner's Chrome first, then runs there", async () => {
    const { inference, sent } = oneCall("browser.tabs", {});
    kernel = await boot(inference);
    const chrome = ownerChrome({ starts: true });
    kernel.setBrowserElsewhere(chrome);
    await kernel.handleMessage("which tab am I on?");
    expect(chrome.ensured).toHaveLength(1);
    expect(resultOf(sent)).toContain("In the owner's Chrome (Chrome on macOS)");
    expect(resultOf(sent)).toContain("Cart: https://shop.example/cart");
  });

  it("refuses the call when the session cannot start, rather than use KOS's own browser", async () => {
    const { inference, sent } = oneCall("browser.tabs", {});
    kernel = await boot(inference);
    const chrome = ownerChrome({ starts: false });
    kernel.setBrowserElsewhere(chrome);
    await kernel.handleMessage("fill in the form on this tab");
    expect(chrome.ensured).toHaveLength(1);
    expect(resultOf(sent)).toContain("did not allow the session in their Chrome");
    expect(resultOf(sent)).not.toContain("KOS's own browser.");
    expect(kernel.browserWhere()).toBe("the owner's Chrome (Chrome on macOS)");
  });

  it("leaves every other tool alone", async () => {
    const { inference } = oneCall("files.ls", { path: "." });
    kernel = await boot(inference);
    const chrome = ownerChrome({ starts: true });
    kernel.setBrowserElsewhere(chrome);
    await kernel.handleMessage("what files are there?");
    expect(chrome.ensured).toEqual([]);
  });
});

describe("a session started unasked on the owner's device", () => {
  let root: string;
  let kernel: Kernel;

  afterEach(() => {
    kernel?.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** A model that makes one browser call for each message, then answers. */
  const everyTurn: Inference = {
    async generate(_t, req) {
      const last = JSON.stringify(req.messages.at(-1));
      if (last.includes("tool_result")) return ended("done");
      return { content: [{ type: "tool_use", id: `t${req.messages.length}`, name: "browser.tabs", input: {} }], stopReason: "tool_use", usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" };
    },
  };

  it("is the owner's own words said in that chat on that device, and no other turn's", async () => {
    root = mkdtempSync(join(tmpdir(), "kos-origin-"));
    kernel = await Kernel.boot({ rootDir: root, secrets: new SecretsRegistry(), inference: everyTurn, profileOverrides: { name: "Kenny", timezone: "UTC" } });
    // What a start in the panel's Chrome would be told, each time one is asked for.
    const heard: (string | undefined)[] = [];
    kernel.setBrowserElsewhere({ ...ownerChrome({ starts: false }), ensure: async () => void heard.push(ownWordsOn("chrome")) });
    const owner = kernel.profile.ownerId;

    // Said in the side panel: the one turn that qualifies.
    const panel = await kernel.handleChannelTurn({ text: "what is on this tab?", userId: owner, channel: "chrome" });
    // The same chat, typed on the dashboard.
    await kernel.handleMessage("and this one?", { sessionId: panel.conversationId, owner: true });
    // Passed on to it by another chat, at the owner's own hand.
    await kernel.dispatchTo(panel.conversationId, "check the tab", undefined, { attended: true, owner: true });
    // A schedule's run, or a blob's own timer, on the same surface.
    await kernel.handleMessage("the nightly check", { sessionId: panel.conversationId, channel: "chrome", attended: false });
    // A resumed approval: the harness's turn, not the owner's words.
    await kernel.handleMessage("carry on", { sessionId: panel.conversationId, channel: "chrome", origin: "system" });
    // A guest's words.
    await kernel.handleChannelTurn({ text: "open the tab", userId: owner, channel: "chrome", conversationId: panel.conversationId, guest: { id: "g1", name: "Sam" } });

    expect(heard[0]).toBe("what is on this tab?");
    expect(heard.slice(1)).toEqual(heard.slice(1).map(() => undefined));
    expect(heard.length).toBeGreaterThanOrEqual(5);
  });
});

describe("a step whose screen had not changed", () => {
  let root: string;
  let kernel: Kernel;

  afterEach(() => {
    kernel?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("shows the chat's last kept picture again, and takes no second capture", async () => {
    const { inference } = oneCall("browser.tabs", {});
    root = mkdtempSync(join(tmpdir(), "kos-frames-"));
    kernel = await Kernel.boot({ rootDir: root, secrets: new SecretsRegistry(), inference, profileOverrides: { name: "Kenny", timezone: "UTC" } });
    let captures = 0;
    const chrome = ownerChrome({ starts: true });
    kernel.setBrowserElsewhere({ ...chrome, picture: async () => (captures++, "TEFURVNU") });
    // The tab's look said in words: nothing changed since the last picture.
    kernel.registry.unregister("browser.tabs");
    kernel.registry.register({ name: "browser.tabs", description: "t", inputSchema: { type: "object" } }, () => `In the owner's Chrome.\n${UNCHANGED}`);
    const chat = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Shop" }).id;
    kernel.frames.add({ conversationId: chat, tool: "browser.look", picture: "RkFSTElFUg==" });
    await kernel.handleMessage("is it still there?", { sessionId: chat, owner: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(captures).toBe(0);
    const frames = kernel.frames.listFor(chat);
    expect(frames).toHaveLength(2);
    expect(kernel.frames.pictureOf(frames[1]!.id)).toBe("RkFSTElFUg==");
  });
});
