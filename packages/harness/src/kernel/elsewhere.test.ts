import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Inference } from "../agent/loop.js";
import type { GenerateRequest, ModelResponse } from "../models/types.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import type { BrowserElsewhere } from "../tools/browser.js";
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
