import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Inference } from "../agent/loop.js";
import type { ModelResponse } from "../models/types.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { RESUME_HEAD } from "./decisions.js";
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
    const settled = kernel.approvals.decided()[0]!;
    expect(settled).toMatchObject({ tool: "danger.run", decidedBy: "auto mode", decidedVia: "auto", conversationId: chat.id });
    expect(kernel.audit.recent(5).find((r) => r.tool === "danger.run")).toMatchObject({ decidedVia: "auto", approvalId: settled.id });
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
    await kernel.deny(kernel.approvals.pending()[0]!.id, undefined, { surface: "dashboard" });
    await sent;
    expect(kernel.approvals.decided()[0]).toMatchObject({ status: "denied" });
  });

  it("asks again for a dispatched message sent again, which stays passed on", async () => {
    const chat = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Target" });
    await setMode(chat.id, { mode: "auto" });
    const sent = kernel.dispatchTo(chat.id, "clear it", "orchestrator:owner", { attended: true, owner: true });
    await vi.waitFor(() => expect(kernel.approvals.pending()).toHaveLength(1));
    await kernel.deny(kernel.approvals.pending()[0]!.id, undefined, { surface: "dashboard" });
    await sent;
    const again = kernel.rewind(chat.id, 0, { owner: true });
    await vi.waitFor(() => expect(kernel.approvals.pending()).toHaveLength(1));
    await kernel.deny(kernel.approvals.pending()[0]!.id, undefined, { surface: "dashboard" });
    await again;
  });

  it("counts the owner's lines as the page does, so Retry never reruns an approval's resume", async () => {
    const chat = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Resume" });
    kernel.sessions.set(chat.id, [
      { role: "user", content: [{ type: "text", text: "clear it" }] },
      { role: "assistant", content: [{ type: "text", text: "asked" }] },
      { role: "user", content: [{ type: "text", text: `${RESUME_HEAD} the pending action:\n#7 danger.run approved, ran` }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]);
    await expect(kernel.rewind(chat.id, 1, { owner: true })).rejects.toThrow(/no message #1/);
  });

  it("never covers words that came by text message, and does cover a picture sent alone", async () => {
    const chat = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Texted" });
    await setMode(chat.id, { mode: "auto" });
    const texted = kernel.handleMessage("clear it", { sessionId: chat.id, userId: kernel.profile.ownerId, owner: true, channel: "sms" });
    await vi.waitFor(() => expect(kernel.approvals.pending()).toHaveLength(1));
    await kernel.deny(kernel.approvals.pending()[0]!.id, undefined, { surface: "dashboard" });
    await texted;
    await kernel.handleMessage("", { sessionId: chat.id, userId: kernel.profile.ownerId, owner: true, attachments: [{ name: "a.txt", mediaType: "text/plain", data: Buffer.from("x").toString("base64") }] });
    expect(kernel.ranUnderAuto(chat.id)).toBe(true);
  });

  it("ends every chat's Auto when the kill switch is thrown", async () => {
    const chat = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Halt" });
    await setMode(chat.id, { mode: "auto" });
    kernel.killSwitch.halt();
    expect(kernel.chatMode(chat.id)).toEqual({ mode: "ask" });
    kernel.killSwitch.resume();
  });

  it("tells the owner once that chats which acted alone are back in Ask", async () => {
    const chat = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Shopping" });
    kernel.settings.set("browser.actsAlone", [chat.id]);
    kernel.close();
    kernel = await Kernel.boot({ rootDir: root, secrets: new SecretsRegistry(), inference: model, chrome: { port: 1, exists: () => false } });
    expect(kernel.chatMode(chat.id)).toEqual({ mode: "ask" });
    const notes = kernel.suggestions.pending().filter((n) => n.title === "Auto is now per chat, and off");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.detail).toContain("Shopping");
    kernel.close();
    kernel = await Kernel.boot({ rootDir: root, secrets: new SecretsRegistry(), inference: model, chrome: { port: 1, exists: () => false } });
    expect(kernel.suggestions.pending().filter((n) => n.title === "Auto is now per chat, and off")).toHaveLength(1);
  });

  it("refuses a mode that is not one", async () => {
    const chat = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Bad" });
    expect((await setMode(chat.id, { mode: "always" })).status).toBe(400);
    expect((await setMode("nope", { mode: "auto" })).status).toBe(404);
  });
});
