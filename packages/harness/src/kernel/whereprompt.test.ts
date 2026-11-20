import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Inference } from "../agent/loop.js";
import type { GenerateRequest, ModelResponse } from "../models/types.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { WHERE_TO_ACT, pairedNote } from "./where.js";

/**
 * Where to act, and what is paired, reach the model on both engines. The
 * owner's chats run on the SDK engine, whose prompt is built apart from the
 * API loop's: this runs a turn on each and reads what each was handed.
 */

const sdk = vi.hoisted(() => ({ asked: [] as { system: string; prompt: string }[] }));

vi.mock("../chat/sdkchat.js", async (original) => ({
  ...(await original<typeof import("../chat/sdkchat.js")>()),
  runSdkChat: async (options: { system: string; prompt: string }) => {
    sdk.asked.push({ system: options.system, prompt: options.prompt });
    return { text: "Done.", calls: [], usage: { inputTokens: 0, outputTokens: 0 }, models: [], costUSD: 0, stopped: false };
  },
}));

const { Kernel } = await import("./kernel.js");
const { BEHAVIOUR_KEY } = await import("./behaviour.js");

const said = (text: string): ModelResponse => ({ content: [{ type: "text", text }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" });

const PAIRED = "Studio Mac (dev_1): a computer (macos), through KOS for Mac; computer.start uses it. online, asks on the device, free";

/** The words of the last message a request ends on: the turn's context and the owner's text. */
const lastWords = (req: GenerateRequest): string =>
  req.messages
    .at(-1)!
    .content.map((b) => (b.type === "text" ? b.text : ""))
    .join("\n");

describe("the rule for where to act", () => {
  it("maps the owner's words to each place, and is short and dashless", () => {
    expect(WHERE_TO_ACT.startsWith("## Where to act\n")).toBe(true);
    expect(WHERE_TO_ACT).not.toMatch(/[—–]/);
    expect(WHERE_TO_ACT.split("\n").length).toBeLessThan(10);
    const line = (tool: string): string => WHERE_TO_ACT.split("\n").find((l) => l.includes(tool))!;
    expect(line("computer.start")).toMatch(/"my Mac".*"my screen".*"KOS in Mac"/);
    expect(line("chrome.start")).toMatch(/"my Chrome".*"my browser".*"KOS in Chrome"/);
    expect(line("browser.* with no session")).toMatch(/"KOS's browser".*"headless"/);
    // A named device is acted on, a bare place carries the last request, and the work never moves unasked.
    expect(WHERE_TO_ACT).toContain("not sent as a link");
    expect(WHERE_TO_ACT).toContain("is where to do their last request");
    expect(WHERE_TO_ACT).toContain("never move the work to another place unasked");
  });

  it("says nothing of devices when nothing tells it what is paired", () => {
    expect(pairedNote(undefined)).toBeUndefined();
    expect(pairedNote("  ")).toBeUndefined();
    expect(pairedNote(PAIRED)).toBe(`## The owner's paired devices\n${PAIRED}`);
  });
});

describe("a turn's prompt", () => {
  let root: string;
  let kernel: InstanceType<typeof Kernel>;
  let requests: GenerateRequest[];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-where-"));
    requests = [];
    sdk.asked.length = 0;
    const inference: Inference = {
      async generate(_task, req) {
        // The turn's own requests: naming a chat asks the model too, with a prompt of its own.
        if (req.system?.includes("## Voice")) requests.push(req);
        return said("Done.");
      },
    };
    kernel = await Kernel.boot({ rootDir: root, secrets: new SecretsRegistry(), inference, chrome: { port: 1, exists: () => false } });
    kernel.setPaired(() => PAIRED);
  });

  afterEach(() => {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("carries the rule in the system prompt and the paired devices with the turn on the API loop", async () => {
    await kernel.handleMessage("rick roll me using KOS in Mac");
    expect(requests[0]?.system).toContain(WHERE_TO_ACT);
    // With the turn, not in the system prompt, which must stay the same every turn to be cached.
    expect(requests[0]?.system).not.toContain(PAIRED);
    expect(lastWords(requests[0]!)).toContain(`## The owner's paired devices\n${PAIRED}`);
    expect(sdk.asked).toHaveLength(0);
  });

  it("carries both on the SDK engine", async () => {
    kernel.settings.set(BEHAVIOUR_KEY, { engine: "sdk" });
    await kernel.handleMessage("rick roll me using KOS in Mac");
    expect(sdk.asked).toHaveLength(1);
    expect(sdk.asked[0]!.system).toContain(WHERE_TO_ACT);
    expect(sdk.asked[0]!.prompt).toContain(`## The owner's paired devices\n${PAIRED}`);
  });

  it("reads what is paired afresh each turn", async () => {
    let paired = PAIRED;
    kernel.setPaired(() => paired);
    await kernel.handleMessage("open the news on my Mac");
    paired = "Nothing is paired. The owner pairs a computer or a Chrome under Settings, Devices.";
    await kernel.handleMessage("open the news on my Mac");
    expect(lastWords(requests[0]!)).toContain(PAIRED);
    expect(lastWords(requests[1]!)).toContain("Nothing is paired.");
  });
});
