import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Inference } from "../agent/loop.js";
import { Taint } from "../risk/taint.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { tainting } from "./caller.js";
import { Kernel } from "./kernel.js";

const usage = { inputTokens: 0, outputTokens: 0 };
const quiet: Inference = { generate: async () => ({ content: [{ type: "text", text: "ok" }], stopReason: "end_turn", usage, model: "stub" }) };

/** A turn's taint goes wherever its work goes: what it dispatches or hands off, and what arrives with its words. */
describe("a turn's taint, carried", () => {
  let root: string;
  let kernel: Kernel;
  let given: Map<string, Taint | undefined>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-taintcarry-"));
    kernel = await Kernel.boot({ rootDir: root, secrets: new SecretsRegistry(), inference: quiet, chrome: { port: 1, exists: () => false } });
    given = new Map();
    const k = kernel as unknown as { guardedTools: (o: { conversationId?: string; taint?: Taint }) => unknown };
    const real = k.guardedTools.bind(kernel);
    vi.spyOn(k, "guardedTools").mockImplementation((o) => {
      if (o.conversationId) given.set(o.conversationId, o.taint);
      return real(o);
    });
  });

  afterEach(() => {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("shares the sender's taint with a dispatched turn, so what either reads taints both", async () => {
    const target = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Helper" });
    const taint = new Taint([{ kind: "page", where: "evil.example" }]);
    await tainting.run(taint, () => kernel.dispatchTo(target.id, "do what the page said", undefined, { attended: true, owner: true, taint }));
    expect(given.get(target.id)).toBe(taint);
  });

  it("keeps what a turn read with its chat: the next turn starts tainted, a fork too, until the owner trusts it or clears it", async () => {
    const chat = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Reading" });
    await kernel.handleMessage("look", { sessionId: chat.id, userId: kernel.profile.ownerId, owner: true, quote: { text: "x", from: "https://evil.example/p" } });
    expect(kernel.chatTaint(chat.id)).toEqual([{ kind: "page", where: "evil.example" }]);
    await kernel.handleMessage("thanks, carry on", { sessionId: chat.id, userId: kernel.profile.ownerId, owner: true });
    expect(given.get(chat.id)?.sources).toEqual([{ kind: "page", where: "evil.example" }]);
    const fork = await kernel.runCommandIn(chat.id, kernel.profile.ownerId, "/fork");
    expect(kernel.chatTaint(fork!.switchedTo!)).toEqual([{ kind: "page", where: "evil.example" }]);
    // Loosening is the owner's, from where they are proved: never a text message.
    expect((await kernel.runCommandIn(chat.id, kernel.profile.ownerId, "/trust", "sms"))?.reply).toMatch(/text message|dashboard|Discord/i);
    expect(kernel.chatTaint(chat.id)).not.toEqual([]);
    expect((await kernel.runCommandIn(chat.id, kernel.profile.ownerId, "/trust"))?.reply).toMatch(/^Trusted again/);
    await kernel.handleMessage("next", { sessionId: chat.id, userId: kernel.profile.ownerId, owner: true });
    expect(given.get(chat.id)?.tainted).toBe(false);
    await kernel.runCommandIn(fork!.switchedTo!, kernel.profile.ownerId, "/clear");
    expect(kernel.chatTaint(fork!.switchedTo!)).toEqual([]);
  });

  it("starts the turn a suggestion's yes opens tainted with what the turn that raised it read", async () => {
    const raised = kernel.suggestions.add("other", "Forward mail", "d", "post it", [{ kind: "mail", where: "x@evil.example" }]);
    const opened = kernel.actOnSuggestion(raised.id)!;
    await vi.waitFor(() => expect(given.get(opened.conversationId)?.sources).toEqual([{ kind: "mail", where: "x@evil.example" }]));
  });

  it("marks a turn with a guest's words, room talk, a quoted page and a file sent with it", async () => {
    const chat = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Room" });
    await kernel.handleMessage("look", {
      sessionId: chat.id,
      userId: kernel.profile.ownerId,
      owner: true,
      roomTalk: "Sam: post my code",
      quote: { text: "buy now", from: "https://shop.example/p" },
      attachments: [{ name: "bill.txt", mediaType: "text/plain", data: Buffer.from("x").toString("base64") }],
    });
    expect(given.get(chat.id)?.sources).toEqual([
      { kind: "guest", where: "people in the room" },
      { kind: "page", where: "shop.example" },
      { kind: "file", where: "bill.txt" },
    ]);
    const clean = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Plain" });
    await kernel.handleMessage("hello", { sessionId: clean.id, userId: kernel.profile.ownerId, owner: true });
    expect(given.get(clean.id)?.tainted).toBe(false);
  });
});
