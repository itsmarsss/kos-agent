import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Kernel } from "./kernel.js";
import type { Inference } from "../agent/loop.js";
import type { ModelResponse } from "../models/types.js";

/**
 * Sending while a turn is already running.
 *
 * A turn runs one at a time, so a follow-up waits. What matters is that it is
 * not lost while it waits: recorded only by its own turn, a queued message
 * lived nowhere but the browser, so a reload dropped something the owner had
 * already pressed send on.
 */
describe("a message sent while a turn is running", () => {
  let root: string;
  let kernel: Kernel;
  let release: (() => void)[] = [];

  /** A model that answers only when the test lets it. */
  const held: Inference = {
    generate: async (): Promise<ModelResponse> => {
      await new Promise<void>((resolve) => release.push(resolve));
      return {
        content: [{ type: "text", text: "answered" }],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      } as ModelResponse;
    },
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-queue-"));
    release = [];
    kernel = await Kernel.boot({ rootDir: root, inference: held });
  });

  afterEach(() => {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  });

  const history = (id: string): string[] =>
    kernel.sessions
      .get(id)
      .filter((m) => m.role === "user")
      .flatMap((m) =>
        m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])),
      );

  it("is on the server while it waits, so a reload still finds it", async () => {
    const id = "chat:owner";
    const first = kernel.handleMessage("first", { sessionId: id });
    // Let the first turn reach the model and block there.
    await new Promise((r) => setTimeout(r, 20));

    const second = kernel.handleMessage("second", { sessionId: id });
    await new Promise((r) => setTimeout(r, 20));

    // Parked rather than kept in the browser: this is what a reloaded page
    // reads to know the message was taken.
    expect(kernel.pending.forConversation(id).map((m) => m.text)).toEqual([
      "second",
    ]);

    release.forEach((fn) => fn());
    await new Promise((r) => setTimeout(r, 30));
    release.forEach((fn) => fn());
    await Promise.all([first, second]);

    // And once it has run it is no longer waiting, it is in the transcript.
    expect(kernel.pending.forConversation(id)).toEqual([]);
    expect(history(id)).toContain("second");
  });

  /*
   * The turn already running rewrites the whole session history when it lands.
   * A waiting message written into that history early was silently erased by
   * it: the owner saw their message, then watched it vanish.
   */
  it("survives the turn it was queued behind finishing", async () => {
    const id = "chat:owner";
    const first = kernel.handleMessage("first", { sessionId: id });
    await new Promise((r) => setTimeout(r, 20));
    const second = kernel.handleMessage("second", { sessionId: id });
    await new Promise((r) => setTimeout(r, 20));

    release.forEach((fn) => fn());
    await new Promise((r) => setTimeout(r, 30));
    release.forEach((fn) => fn());
    await Promise.all([first, second]);

    expect(history(id)).toContain("first");
    expect(history(id)).toContain("second");
  });

  it("is asked once, not twice", async () => {
    const id = "chat:owner";
    const first = kernel.handleMessage("first", { sessionId: id });
    await new Promise((r) => setTimeout(r, 20));
    const second = kernel.handleMessage("second", { sessionId: id });
    await new Promise((r) => setTimeout(r, 20));

    release.forEach((fn) => fn());
    await new Promise((r) => setTimeout(r, 30));
    release.forEach((fn) => fn());
    await Promise.all([first, second]);

    // Recorded on arrival and then again by its own turn would leave it twice
    // in the history, and the model would answer a question asked double.
    const said = history(id).filter((t) => t === "second");
    expect(said).toHaveLength(1);
  });

  it("keeps the order they were sent in", async () => {
    const id = "chat:owner";
    const first = kernel.handleMessage("one", { sessionId: id });
    await new Promise((r) => setTimeout(r, 20));
    const second = kernel.handleMessage("two", { sessionId: id });
    await new Promise((r) => setTimeout(r, 20));

    release.forEach((fn) => fn());
    await new Promise((r) => setTimeout(r, 30));
    release.forEach((fn) => fn());
    await Promise.all([first, second]);

    const said = history(id);
    expect(said.indexOf("one")).toBeLessThan(said.indexOf("two"));
  });

  /*
   * Editing, dropping and forking a message that is still waiting. All three
   * are refused once its turn has started, because from that point the
   * question has been asked and changing it would rewrite the record of
   * something already answered.
   */
  describe("managing what is still waiting", () => {
    const queueOne = async (): Promise<{ id: string; pendingId: number; first: Promise<unknown> }> => {
      // A real conversation, because forking copies its title, brief and tool
      // scope, and the dashboard never queues into a bare session id.
      const id = kernel.conversations.create({ userId: "owner", title: "Work" }).id;
      const first = kernel.handleMessage("first", { sessionId: id });
      await new Promise((r) => setTimeout(r, 20));
      void kernel.handleMessage("second", { sessionId: id });
      await new Promise((r) => setTimeout(r, 20));
      const pendingId = kernel.pending.forConversation(id)[0]!.id;
      return { id, pendingId, first };
    };

    const finish = async (): Promise<void> => {
      for (let i = 0; i < 4; i++) {
        release.forEach((fn) => fn());
        await new Promise((r) => setTimeout(r, 25));
      }
    };

    it("edits a message before it runs", async () => {
      const { id, pendingId } = await queueOne();
      expect(kernel.pending.edit(pendingId, "rewritten")).toBe(true);
      expect(kernel.pending.forConversation(id)[0]?.text).toBe("rewritten");
      await finish();
    });

    it("drops a message before it runs", async () => {
      const { id, pendingId } = await queueOne();
      expect(kernel.pending.remove(pendingId)).toBe(true);
      expect(kernel.pending.forConversation(id)).toEqual([]);
      await finish();
    });

    it("refuses to edit or drop one that has already been taken", async () => {
      const { pendingId } = await queueOne();
      await finish();
      // Its turn ran, so it is no longer waiting and neither call finds it.
      expect(kernel.pending.edit(pendingId, "too late")).toBe(false);
      expect(kernel.pending.remove(pendingId)).toBe(false);
    });

    it("forks a waiting message into a chat of its own", async () => {
      const { id, pendingId } = await queueOne();
      const waiting = kernel.pending.get(pendingId)!;
      const forkId = await kernel.forkPending(waiting);

      expect(forkId).not.toBe(id);
      // Claimed, so it cannot also run in the original.
      expect(kernel.pending.forConversation(id)).toEqual([]);
      // The fork starts from a copy of the chat as it stood.
      expect(kernel.conversations.get(forkId)?.title).toContain("fork");
      await finish();
    });
  });
});