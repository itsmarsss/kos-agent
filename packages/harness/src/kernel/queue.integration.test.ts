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
});
