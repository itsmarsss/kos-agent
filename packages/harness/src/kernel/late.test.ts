import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Inference } from "../agent/loop.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Kernel, notRunNote } from "./kernel.js";

/** Messages read on KOS's return: new enough they run as live; older they are told, not run. */
describe("a message sent while KOS was away", () => {
  let root: string;
  let kernel: Kernel;
  let chat: string;
  let calls: number;
  let notes: { conversationId: string; text: string }[];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-late-"));
    calls = 0;
    const inference: Inference = {
      async generate() {
        calls += 1;
        return { content: [{ type: "text", text: "ok" }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" };
      },
    };
    kernel = await Kernel.boot({ rootDir: root, secrets: new SecretsRegistry(), inference, chrome: { port: 1, exists: () => false } });
    chat = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Garden" }).id;
    notes = [];
    kernel.progress.subscribe((e) => {
      if (e.kind === "note") notes.push({ conversationId: e.conversationId, text: e.text });
    });
  });

  afterEach(() => {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  });

  const turn = (sentAgo: number, extra: { missed?: string[]; guest?: { id: string; name: string } } = {}) =>
    kernel.handleChannelTurn({ text: "delete the old branch", userId: kernel.profile.ownerId, channel: "discord", conversationId: chat, late: true, sentAt: Date.now() - sentAgo, ...extra });

  it("runs as live when it is under ten minutes old", async () => {
    const res = await turn(2 * 60_000);
    expect(calls).toBeGreaterThan(0);
    expect(res.reply).toBe("ok");
    expect(notes).toEqual([]);
  });

  it("is not run when older, the owner's or a guest's, and the chat gets the room's note", async () => {
    const res = await turn(30 * 60_000, { missed: ["delete the old branch", "Sam: and the tag"] });
    const guest = await turn(30 * 60_000, { guest: { id: "g1", name: "Sam" } });
    expect(calls).toBe(0);
    expect(res.reply).toBe(notRunNote(["delete the old branch", "Sam: and the tag"]));
    expect(res.reply).toMatch(/^These were sent while KOS was offline and not run:\n> delete the old branch\n> Sam: and the tag\nReply to run them\.$/);
    expect(guest.reply).toMatch(/^This was sent while KOS was offline and not run:/);
    expect(notes).toEqual([
      { conversationId: chat, text: res.reply },
      { conversationId: chat, text: guest.reply },
    ]);
  });
});
