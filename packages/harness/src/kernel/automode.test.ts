import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Inference } from "../agent/loop.js";
import type { ModelResponse } from "../models/types.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { AUTO_PREFIX } from "./guarded.js";
import { Kernel } from "./kernel.js";
import { handleApiRequest } from "./server.js";

const usage = { inputTokens: 0, outputTokens: 0 };

/** A model that makes one risky call, then says what came back. */
function oneRiskyCall(): Inference & { results: string[] } {
  const results: string[] = [];
  return {
    results,
    async generate(_task, req) {
      const last = JSON.stringify(req.messages.at(-1));
      if (last.includes("tool_result")) {
        results.push(last);
        return { content: [{ type: "text", text: "done" }], stopReason: "end_turn", usage, model: "stub" } satisfies ModelResponse;
      }
      return { content: [{ type: "tool_use", id: "t1", name: "danger.run", input: { what: "clear the cache" } }], stopReason: "tool_use", usage, model: "stub" } satisfies ModelResponse;
    },
  };
}

describe("a chat's mode, through the kernel", () => {
  let root: string;
  let kernel: Kernel;
  let model: ReturnType<typeof oneRiskyCall>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-auto-"));
    model = oneRiskyCall();
    kernel = await Kernel.boot({ rootDir: root, secrets: new SecretsRegistry(), inference: model, chrome: { port: 1, exists: () => false } });
    kernel.registry.register({ name: "danger.run", description: "d", inputSchema: { type: "object" } }, () => "cleared", { floor: "risky" });
  });

  afterEach(() => {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  });

  const setMode = (id: string, mode: unknown) => handleApiRequest(kernel, { method: "POST", path: "/api/conversations/mode", body: { id, mode } });

  it("runs the owner's risky call unasked in Auto, decided by auto mode, and lists the chat as in Auto", async () => {
    const chat = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Overnight" });
    expect((await setMode(chat.id, { mode: "auto" })).body).toEqual({ id: chat.id, mode: { mode: "auto" } });
    const listed = (await handleApiRequest(kernel, { method: "GET", path: "/api/conversations" })).body as { id: string; mode?: unknown }[];
    expect(listed.find((c) => c.id === chat.id)?.mode).toEqual({ mode: "auto" });

    const { reply } = await kernel.handleMessage("clear it", { sessionId: chat.id, userId: kernel.profile.ownerId, owner: true });
    expect(reply).toBe("done");
    expect(model.results[0]).toContain(AUTO_PREFIX);
    expect(kernel.approvals.pending()).toEqual([]);
    expect(kernel.approvals.decided()[0]).toMatchObject({ tool: "danger.run", decidedBy: "auto mode", conversationId: chat.id });
  });

  it("ends Auto set for this task when the chat's turn ends", async () => {
    const chat = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Once" });
    const told: unknown[] = [];
    kernel.bus.on("chat:mode", (e) => void told.push(e));
    await setMode(chat.id, { mode: "auto", until: "task" });
    await kernel.handleMessage("clear it", { sessionId: chat.id, userId: kernel.profile.ownerId, owner: true });
    expect(model.results[0]).toContain(AUTO_PREFIX);
    expect(kernel.chatMode(chat.id)).toEqual({ mode: "ask" });
    expect(told.at(-1)).toEqual({ kind: "chat:mode", conversationId: chat.id, mode: { mode: "ask" } });
  });

  it("asks for work dispatched into a chat in Auto, even when the owner's turn sent it", async () => {
    const chat = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Target" });
    await setMode(chat.id, { mode: "auto" });
    const sent = kernel.dispatchTo(chat.id, "clear it", undefined, { attended: true, owner: true });
    await vi.waitFor(() => expect(kernel.approvals.pending().map((a) => a.tool)).toEqual(["danger.run"]));
    await kernel.deny(kernel.approvals.pending()[0]!.id);
    await sent;
    expect(kernel.approvals.decided()[0]).toMatchObject({ status: "denied" });
  });

  it("refuses a mode that is not one", async () => {
    const chat = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Bad" });
    expect((await setMode(chat.id, { mode: "always" })).status).toBe(400);
    expect((await setMode("nope", { mode: "auto" })).status).toBe(404);
  });
});
