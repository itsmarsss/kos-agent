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
    spot: () => (live ? { tab: "77", url: "https://shop.example/cart", moved: 0 } : undefined),
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

/** A model that calls each tool in turn, one a reply, then answers. */
function inTurn(tools: string[]): Inference {
  let i = 0;
  return {
    async generate() {
      const tool = tools[i++];
      if (!tool) return ended("done");
      return { content: [{ type: "tool_use", id: `t${i}`, name: tool, input: {} }], stopReason: "tool_use", usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" };
    },
  };
}

/** A tool, put in place of any of that name, answering each call in turn with the next of `answers`. */
function answering(kernel: Kernel, name: string, answers: (string | { text: string; images: { mediaType: string; data: string }[]; endUnseen?: boolean })[]): void {
  let i = 0;
  kernel.registry.unregister(name);
  kernel.registry.register({ name, description: "t", inputSchema: { type: "object" } }, () => answers[Math.min(i++, answers.length - 1)]!);
}

const jpeg = (data: string) => ({ mediaType: "image/jpeg", data });

describe("the picture kept after a step", () => {
  let root: string;
  let kernel: Kernel;

  afterEach(() => {
    kernel?.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function boot(tools: string[], chrome: BrowserElsewhere): Promise<string> {
    root = mkdtempSync(join(tmpdir(), "kos-frames-"));
    kernel = await Kernel.boot({ rootDir: root, secrets: new SecretsRegistry(), inference: inTurn(tools), profileOverrides: { name: "Kenny", timezone: "UTC" } });
    kernel.setBrowserElsewhere(chrome);
    return kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Shop" }).id;
  }

  /** Each frame of the chat, oldest first: its picture and site. */
  const framesOf = (chat: string) => kernel.frames.listFor(chat).map((f) => ({ picture: kernel.frames.pictureOf(f.id), site: f.site, tool: f.tool }));
  const settled = () => new Promise((r) => setTimeout(r, 20));

  it("unchanged, is the very picture last shown, with no second capture", async () => {
    let captures = 0;
    const chat = await boot(["browser.look", "browser.tabs"], { ...ownerChrome({ starts: true }), picture: async () => (captures++, "TEFURVNU") });
    answering(kernel, "browser.look", [{ text: "In the owner's Chrome.", images: [jpeg("RkFSTElFUg==")] }]);
    answering(kernel, "browser.tabs", [`In the owner's Chrome.\n${UNCHANGED}`]);
    await kernel.handleMessage("is it still there?", { sessionId: chat, owner: true });
    await settled();
    expect(captures).toBe(0);
    expect(framesOf(chat)).toEqual([
      { picture: "RkFSTElFUg==", site: "shop.example", tool: "browser.look" },
      { picture: "RkFSTElFUg==", site: "shop.example", tool: "browser.tabs" },
    ]);
  });

  it("unchanged on the computer, is the computer's last picture, not a frame the browser took since", async () => {
    const chat = await boot(["computer.look", "browser.tabs", "computer.look"], { ...ownerChrome({ starts: true }), picture: async () => "QlJPV1NFUg==" });
    answering(kernel, "computer.look", [{ text: "The screen.", images: [jpeg("U0NSRUVO")] }, UNCHANGED]);
    answering(kernel, "browser.tabs", ["In the owner's Chrome."]);
    await kernel.handleMessage("and the screen?", { sessionId: chat, owner: true });
    await settled();
    const frames = framesOf(chat);
    expect(frames).toContainEqual({ picture: "QlJPV1NFUg==", site: "shop.example", tool: "browser.tabs" });
    expect(frames.filter((f) => f.tool === "computer.look")).toEqual([
      { picture: "U0NSRUVO", site: null, tool: "computer.look" },
      { picture: "U0NSRUVO", site: null, tool: "computer.look" },
    ]);
  });

  it("unchanged again and again, keeps its picture after newer frames let the original go", async () => {
    const chat = await boot(["computer.look", "", "computer.look", "", "computer.look"], ownerChrome({ starts: true }));
    answering(kernel, "computer.look", [{ text: "The screen.", images: [jpeg("U0NSRUVO")] }, UNCHANGED]);
    await kernel.handleMessage("look", { sessionId: chat, owner: true });
    for (let i = 0; i < 149; i++) kernel.frames.add({ conversationId: chat, tool: "browser.tabs", picture: "Rg==" });
    await kernel.handleMessage("again", { sessionId: chat, owner: true });
    await kernel.handleMessage("and again", { sessionId: chat, owner: true });
    await settled();
    expect(framesOf(chat).filter((f) => f.tool === "computer.look")).toEqual([
      { picture: "U0NSRUVO", site: null, tool: "computer.look" },
      { picture: "U0NSRUVO", site: null, tool: "computer.look" },
    ]);
  });

  it("unchanged on one site, is that site's picture under its own name, not another's taken since", async () => {
    let site = "a.example";
    const chat = await boot(["browser.look", "browser.tabs", "browser.look"], {
      ...ownerChrome({ starts: true }),
      siteOf: () => site,
      picture: async () => "Qg==",
    });
    let looks = 0;
    kernel.registry.unregister("browser.look");
    kernel.registry.register({ name: "browser.look", description: "t", inputSchema: { type: "object" } }, () =>
      looks++ === 0 ? { text: "A.", images: [jpeg("QQ==")] } : UNCHANGED,
    );
    kernel.registry.unregister("browser.tabs");
    kernel.registry.register({ name: "browser.tabs", description: "t", inputSchema: { type: "object" } }, () => {
      site = "b.example";
      setTimeout(() => (site = "a.example"), 5);
      return "Went to B and back.";
    });
    await kernel.handleMessage("look again", { sessionId: chat, owner: true });
    await settled();
    expect(framesOf(chat).filter((f) => f.tool === "browser.look")).toEqual([
      { picture: "QQ==", site: "a.example", tool: "browser.look" },
      { picture: "QQ==", site: "a.example", tool: "browser.look" },
    ]);
  });

  it("is none of an earlier page when a visit's last page had no picture: the tab is pictured afresh", async () => {
    const chat = await boot(["browser.visit"], { ...ownerChrome({ starts: true }), picture: async () => "TEFTVA==" });
    answering(kernel, "browser.visit", [{ text: "Opened two.", images: [jpeg("RklSU1Q=")], endUnseen: true }]);
    await kernel.handleMessage("open both", { sessionId: chat, owner: true });
    await settled();
    expect(framesOf(chat)).toEqual([{ picture: "TEFTVA==", site: "shop.example", tool: "browser.visit" }]);
  });

  it("taken in the background, is named for the site the tab was on, and dropped if the tab moved meanwhile", async () => {
    let site = "a.example";
    let moves = false;
    const chat = await boot(["browser.tabs", "browser.tabs"], {
      ...ownerChrome({ starts: true }),
      siteOf: () => site,
      picture: async () => {
        if (moves) site = "b.example";
        moves = true;
        return "VEFC";
      },
    });
    answering(kernel, "browser.tabs", ["In the owner's Chrome."]);
    await kernel.handleMessage("where is it?", { sessionId: chat, owner: true });
    await settled();
    expect(framesOf(chat)).toEqual([{ picture: "VEFC", site: "a.example", tool: "browser.tabs" }]);
  });
});
