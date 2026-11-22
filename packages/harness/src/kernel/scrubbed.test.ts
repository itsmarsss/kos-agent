import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Inference } from "../agent/loop.js";
import type { SdkChatOptions, SdkChatResult } from "../chat/sdkchat.js";
import { resultText } from "../models/heard.js";
import type { GenerateRequest, ModelResponse } from "../models/types.js";
import type { ProgressEvent } from "./progress.js";

/**
 * A secret a tool's answer carries back, in any of the forms the scrubber
 * knows, never reaches the model, a reader or the audit, on either engine.
 */

const sdk = vi.hoisted(() => ({ run: undefined as ((o: SdkChatOptions) => Promise<SdkChatResult>) | undefined }));

vi.mock("../chat/sdkchat.js", async (actual) => ({
  ...(await actual<typeof import("../chat/sdkchat.js")>()),
  runSdkChat: (o: SdkChatOptions) => sdk.run!(o),
}));

const { Kernel } = await import("./kernel.js");
const { SecretsRegistry } = await import("../secrets/secrets.js");
const { BEHAVIOUR_KEY } = await import("./behaviour.js");

/** A made-up key; nothing real. */
const CANARY = "tok_Canary+Value/42";
const FORMS = [
  CANARY,
  JSON.stringify(CANARY).slice(1, -1),
  encodeURIComponent(CANARY),
  new URLSearchParams({ k: CANARY }).toString().slice(2),
  Buffer.from(`x${CANARY}`).toString("base64"),
  Buffer.from(`xx${CANARY}`).toString("base64url"),
  Buffer.from(CANARY).toString("hex"),
];
const LEAKY = FORMS.map((form, i) => `form ${i}: ${form}`).join("\n");

/** True if any form of the canary survives in `text`. */
const leaks = (text: string): boolean => [CANARY, encodeURIComponent(CANARY), Buffer.from(CANARY).toString("hex")].some((form) => text.includes(form)) || text.includes("Canary");

const respond = (content: ModelResponse["content"], stopReason: ModelResponse["stopReason"]): ModelResponse => ({ content, stopReason, usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" });

describe("a secret in what a tool answers", () => {
  let root: string;
  let kernel: InstanceType<typeof Kernel>;
  let events: ProgressEvent[];
  const requests: GenerateRequest[] = [];

  const inference: Inference = {
    async generate(_t, request) {
      requests.push(request);
      return requests.length === 1 ? respond([{ type: "tool_use", id: "t1", name: "leaky", input: {} }], "tool_use") : respond([{ type: "text", text: "done" }], "end_turn");
    },
  };

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    root = mkdtempSync(join(tmpdir(), "kos-scrubbed-"));
    requests.length = 0;
    kernel = await Kernel.boot({ rootDir: root, secrets: new SecretsRegistry({ canary: CANARY }), inference, chrome: { port: 1, exists: () => false } });
    kernel.registry.register({ name: "leaky", description: "answers with a key", inputSchema: { type: "object" } }, () => LEAKY);
    events = [];
    kernel.progress.subscribe((event) => events.push(event));
  });

  afterEach(() => {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const expectScrubbed = (seenByModel: string): void => {
    expect(seenByModel).toContain("[secret canary]");
    expect(leaks(seenByModel)).toBe(false);
    const ended = events.find((e): e is Extract<ProgressEvent, { kind: "tool-end" }> => e.kind === "tool-end" && e.tool === "leaky");
    expect(ended?.result).toContain("[secret canary]");
    expect(leaks(JSON.stringify(events))).toBe(false);
    const audited = kernel.audit.recent().find((a) => a.tool === "leaky");
    expect(audited?.result).toContain("[secret canary]");
    expect(leaks(JSON.stringify(kernel.audit.recent()))).toBe(false);
    expect(kernel.secrets.scrubbed()).toBeGreaterThanOrEqual(FORMS.length);
  };

  it("is scrubbed on the API engine", async () => {
    await kernel.handleMessage("check the key");
    const sent = requests[1]!.messages.flatMap((m) => m.content).flatMap((b) => (b.type === "tool_result" ? [resultText(b)] : [])).join("\n");
    expectScrubbed(sent);
  });

  it("is scrubbed on the SDK engine, and so are the words the model streams", async () => {
    kernel.settings.set(BEHAVIOUR_KEY, { engine: "sdk" });
    let seenByModel = "";
    sdk.run = async (o) => {
      const result = await o.tools.execute("leaky", {});
      seenByModel = result.content;
      o.onCall?.({ id: "sdk-t-1", name: "leaky", input: {}, result: result.content, isError: false });
      o.onDelta?.({ kind: "text", text: `the key was ${CANARY}` });
      return { text: "done", calls: [], usage: { inputTokens: 0, outputTokens: 0 }, models: [], costUSD: 0, stopped: false };
    };
    const chat = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Keys" }).id;
    await kernel.handleChannelTurn({ text: "check the key", userId: kernel.profile.ownerId, channel: "dashboard", conversationId: chat });
    expectScrubbed(seenByModel);
    expect(events.flatMap((e) => (e.kind === "delta" ? [e.text] : [])).join("")).toBe("the key was [secret canary]");
  });

  it("keeps no secret in what the SDK engine's turn logs for memory", async () => {
    kernel.settings.set(BEHAVIOUR_KEY, { engine: "sdk" });
    sdk.run = async () => ({ text: `noted, the key is ${CANARY}`, calls: [], usage: { inputTokens: 0, outputTokens: 0 }, models: [], costUSD: 0, stopped: false });
    const chat = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Keys" }).id;
    await kernel.handleChannelTurn({ text: `remember my key ${CANARY}`, userId: kernel.profile.ownerId, channel: "dashboard", conversationId: chat });
    const logged = kernel.events.since(kernel.profile.ownerId, 0, 10);
    expect(logged).toHaveLength(2);
    expect(leaks(JSON.stringify(logged))).toBe(false);
    expect(leaks(JSON.stringify(kernel.facts.all(kernel.profile.ownerId)))).toBe(false);
  });
});
