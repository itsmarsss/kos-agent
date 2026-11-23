import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Inference } from "../agent/loop.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Kernel } from "./kernel.js";
import { saidText } from "../models/types.js";

/** A chat longer than what it keeps: each message is kept once, the oldest let go. */
describe("a chat that outgrows what it keeps", () => {
  let root: string;
  let kernel: Kernel;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-trimmed-"));
    const inference: Inference = {
      async generate() {
        return { content: [{ type: "text", text: "Noted." }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" };
      },
    };
    kernel = await Kernel.boot({ rootDir: root, secrets: new SecretsRegistry(), inference, chrome: { port: 1, exists: () => false } });
    kernel.sessions.configure({ maxExchanges: 3 });
  });

  afterEach(() => {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("stores the owner's words once per turn after the trim starts", async () => {
    const chat = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Long" }).id;
    for (let i = 0; i < 6; i++) await kernel.handleMessage(`Message ${i}`, { sessionId: chat, userId: kernel.profile.ownerId, owner: true });
    const said = kernel.sessions.get(chat).map((m) => `${m.role}:${saidText(m.content).trim()}`);
    expect(said).toEqual(["user:Message 3", "assistant:Noted.", "user:Message 4", "assistant:Noted.", "user:Message 5", "assistant:Noted."]);
  });
});
