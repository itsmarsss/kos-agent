import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Inference } from "../agent/loop.js";
import type { GenerateRequest, ModelResponse } from "../models/types.js";
import { SecretsRegistry } from "../secrets/secrets.js";

/**
 * The typed-block note reaches the model on both engines. The SDK engine
 * builds its prompt apart from the API loop, so a note that only the API
 * path carried would never reach the owner's chats; this runs a turn on
 * each and reads the system prompt each one was handed.
 */

const sdk = vi.hoisted(() => ({ systems: [] as string[] }));

vi.mock("../chat/sdkchat.js", async (original) => ({
  ...(await original<typeof import("../chat/sdkchat.js")>()),
  runSdkChat: async (options: { system: string }) => {
    sdk.systems.push(options.system);
    return { text: "Drafted.", calls: [], usage: { inputTokens: 0, outputTokens: 0 }, models: [], costUSD: 0, stopped: false };
  },
}));

const { Kernel } = await import("./kernel.js");
const { BEHAVIOUR_KEY } = await import("./behaviour.js");

const said = (text: string): ModelResponse => ({ content: [{ type: "text", text }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" });

describe("the typed-block note", () => {
  let root: string;
  let kernel: InstanceType<typeof Kernel>;
  let requests: GenerateRequest[];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-blocks-"));
    requests = [];
    sdk.systems.length = 0;
    const inference: Inference = {
      async generate(_task, req) {
        requests.push(req);
        return said("Drafted.");
      },
    };
    kernel = await Kernel.boot({ rootDir: root, secrets: new SecretsRegistry(), inference, chrome: { port: 1, exists: () => false } });
  });

  afterEach(() => {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("is in the system prompt on the API loop", async () => {
    await kernel.handleMessage("draft an email to Sam");
    expect(requests[0]?.system).toContain("## Typed blocks");
    expect(sdk.systems).toHaveLength(0);
  });

  it("is in the system prompt the SDK engine is handed", async () => {
    kernel.settings.set(BEHAVIOUR_KEY, { engine: "sdk" });
    await kernel.handleMessage("draft an email to Sam");
    expect(sdk.systems).toHaveLength(1);
    expect(sdk.systems[0]).toContain("## Typed blocks");
    expect(sdk.systems[0]).toContain("kos:message (to, channel");
  });
});
