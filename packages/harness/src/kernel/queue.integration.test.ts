import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Kernel } from "./kernel.js";
import { handleApiRequest } from "./server.js";
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
  /** How many times the model was asked: what actually ran. */
  let asked = 0;

  /** A model that answers only when the test lets it. */
  const held: Inference = {
    generate: async (): Promise<ModelResponse> => {
      asked += 1;
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
    asked = 0;
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

  it("keeps where it came from, so the dashboard shows it waiting as it will show it sent, and the list counts it", async () => {
    const chat = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Queue" });
    const id = chat.id;
    const first = kernel.handleMessage("first", { sessionId: id });
    await new Promise((r) => setTimeout(r, 20));
    const room = { kind: "channel" as const, id: "c1", name: "leetcode" };
    const second = kernel.handleMessage("second", { sessionId: id, channel: "discord", room });
    const third = kernel.handleMessage("third", { sessionId: id });
    await new Promise((r) => setTimeout(r, 20));

    // The parked message carries its origin; one typed on the dashboard carries none.
    expect(kernel.pending.forConversation(id).map((m) => [m.text, m.origin])).toEqual([
      ["second", { via: "discord", room }],
      ["third", undefined],
    ]);
    const listed = (await handleApiRequest(kernel, { method: "GET", path: "/api/conversations" })).body as { id: string; queued?: number }[];
    expect(listed.find((c) => c.id === id)?.queued).toBe(2);
    const opened = (await handleApiRequest(kernel, { method: "GET", path: `/api/conversations/${encodeURIComponent(id)}/messages` })).body as {
      pending: { text: string; origin?: unknown }[];
    };
    expect(opened.pending.map((p) => [p.text, p.origin])).toEqual([
      ["second", { via: "discord", room }],
      ["third", undefined],
    ]);

    for (let i = 0; i < 3; i++) {
      release.forEach((fn) => fn());
      await new Promise((r) => setTimeout(r, 30));
    }
    await Promise.all([first, second, third]);
    expect(kernel.pending.forConversation(id)).toEqual([]);
    const after = (await handleApiRequest(kernel, { method: "GET", path: "/api/conversations" })).body as { id: string; queued?: number }[];
    expect(after.find((c) => c.id === id)?.queued).toBeUndefined();
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

  /** Let every turn there is run to the end. */
  const drain = async (...turns: Promise<unknown>[]): Promise<void> => {
    for (let i = 0; i < 5; i += 1) {
      release.forEach((fn) => fn());
      await new Promise((r) => setTimeout(r, 20));
    }
    await Promise.all(turns);
  };

  /** A turn running in a chat of its own, and a second message waiting behind it. */
  const waitingBehind = async (): Promise<{ id: string; first: Promise<unknown>; second: Promise<{ dropped?: boolean }>; row: number }> => {
    const id = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Queue" }).id;
    const first = kernel.handleMessage("first", { sessionId: id });
    await new Promise((r) => setTimeout(r, 20));
    const second = kernel.handleMessage("second", { sessionId: id });
    await new Promise((r) => setTimeout(r, 20));
    return { id, first, second, row: kernel.pending.forConversation(id)[0]!.id };
  };

  it("runs a waiting message as it was edited, not as it was sent", async () => {
    const { id, first, second, row } = await waitingBehind();
    expect(kernel.pending.edit(row, "second, edited")).toBe(true);
    await drain(first, second);
    expect(history(id)).toEqual(["first", "second, edited"]);
    expect(asked).toBe(2);
  });

  it("does not run a waiting message that was dropped, and says it was dropped", async () => {
    const { id, first, second, row } = await waitingBehind();
    expect(kernel.pending.remove(row)).toBe(true);
    await drain(first, second);
    expect(await second).toMatchObject({ reply: "", dropped: true });
    expect(history(id)).toEqual(["first"]);
    expect(asked).toBe(1);
  });

  it("runs a forked message once, in the fork, and not again where it was waiting", async () => {
    const { id, first, second, row } = await waitingBehind();
    const fork = await kernel.forkPending(kernel.pending.get(row)!);
    await drain(first, second);
    expect(await second).toMatchObject({ dropped: true });
    expect(history(id)).toEqual(["first"]);
    expect(history(fork).filter((t) => t === "second")).toHaveLength(1);
    expect(asked).toBe(2);
  });

  it("runs one parked behind another queued turn as edited, and skips it when dropped", async () => {
    const id = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Queue" }).id;
    // A schedule's turn is never steered: these queue behind the running one.
    const first = kernel.handleMessage("first", { sessionId: id, origin: "system" });
    await new Promise((r) => setTimeout(r, 20));
    const second = kernel.handleMessage("second", { sessionId: id, origin: "system" });
    const third = kernel.handleMessage("third", { sessionId: id, origin: "system" });
    await new Promise((r) => setTimeout(r, 20));
    const [two, three] = kernel.pending.forConversation(id);
    kernel.pending.edit(two!.id, "second, edited");
    kernel.pending.remove(three!.id);
    await drain(first, second, third);
    expect(history(id)).toEqual(["first", "second, edited"]);
    expect(await third).toMatchObject({ dropped: true });
    expect(asked).toBe(2);
  });

  it("runs what a restart left waiting as whoever sent it, in order, and names in the chat what it will not run", async () => {
    const id = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Left" }).id;
    const ana = { id: "a1", name: "Ana" };
    kernel.pending.add(id, "owner words", [], { via: "discord" }, { owner: true, channel: "discord" });
    kernel.pending.add(id, "[Ana, a guest in the channel] guest words", [], { via: "discord", from: { kind: "guest", name: "Ana", id: "a1" } }, { guest: ana, owner: false, origin: "system", channel: "discord" });
    kernel.pending.add(id, "a schedule's", [], undefined, { origin: "system" });
    kernel.pending.add(id, "from before flags");
    // The room is still open to guests, so the guest's runs.
    kernel.setChannelAudience(id, "guests");
    kernel.close();
    kernel = await Kernel.boot({ rootDir: root, inference: held });
    const said: { text: string; origin: string; channel: string | null; resumed?: boolean }[] = [];
    kernel.bus.on("turn:said", (e) => void said.push({ text: e.text, origin: e.origin, channel: e.channel, ...(e.resumed ? { resumed: true } : {}) }));
    kernel.replayQueued();
    expect(kernel.pending.forConversation(id)).toEqual([]);
    await drain();
    // The owner's as the owner's, the guest's as the guest's and never as the owner's; both go back to Discord.
    expect(said).toEqual([
      { text: "owner words", origin: "owner", channel: "discord", resumed: true },
      { text: "[Ana, a guest in the channel] guest words", origin: "system", channel: "discord", resumed: true },
    ]);
    expect(asked).toBe(2);
    const notes = kernel.sessions.get(id).filter((m) => m.role === "assistant").flatMap((m) => m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])));
    expect(notes[0]).toBe("2 queued messages were not run after a restart; resend?\n> a schedule's\n> from before flags");
  });

  it("keeps every flag of what it runs after a restart, and announces what waited too long or a shut room's guest", async () => {
    const id = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Left" }).id;
    const ana = { id: "a1", name: "Ana" };
    kernel.pending.add(id, "handed on", [], { via: "discord" }, { owner: true, channel: "discord", trail: ["chat-a"], maxIterations: 40 });
    kernel.pending.add(id, "[Ana, a guest in the channel] guest words", [], undefined, { guest: ana, owner: false, origin: "system", channel: "discord", guestFiles: ["a.png"] });
    const old = kernel.pending.add(id, "an hour ago", [], undefined, { owner: true, channel: "discord" });
    (kernel.pending as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => unknown } } }).db.prepare(`UPDATE pending_messages SET created_at = ? WHERE id = ?`).run(Date.now() - 3_600_000, old);
    kernel.close();
    kernel = await Kernel.boot({ rootDir: root, inference: held });
    const ran: { text: string; opts: Record<string, unknown> }[] = [];
    const real = kernel.handleMessage.bind(kernel);
    kernel.handleMessage = (text, opts = {}) => (ran.push({ text, opts: opts as Record<string, unknown> }), real(text, opts));
    kernel.replayQueued();
    await drain();
    expect(ran.map((r) => [r.text, r.opts.trail, r.opts.maxIterations])).toEqual([["handed on", ["chat-a"], 40]]);
    const notes = kernel.sessions.get(id).filter((m) => m.role === "assistant").flatMap((m) => m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])));
    expect(notes[0]).toBe("2 queued messages were not run after a restart; resend?\n> [Ana, a guest in the channel] guest words\n> an hour ago");
    // Open to guests again, a fresh guest row runs as the guest's, with the files it named.
    kernel.setChannelAudience(id, "guests");
    kernel.pending.add(id, "[Ana, a guest in the channel] again", [], undefined, { guest: ana, owner: false, origin: "system", channel: "discord", guestFiles: ["a.png"] });
    kernel.close();
    kernel = await Kernel.boot({ rootDir: root, inference: held });
    const again: Record<string, unknown>[] = [];
    const next = kernel.handleMessage.bind(kernel);
    kernel.handleMessage = (text, opts = {}) => (again.push({ text, ...(opts as Record<string, unknown>) }), next(text, opts));
    kernel.replayQueued();
    await drain();
    expect(again).toMatchObject([{ text: "again", guest: ana, guestFiles: ["a.png"] }]);
  });

  it("keeps when a queued message was sent, and judges it by that after a restart, not by when it was queued", async () => {
    const id = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Late" }).id;
    const sentAt = Date.now() - 11 * 60_000;
    const first = kernel.handleMessage("first", { sessionId: id, origin: "system" });
    await new Promise((r) => setTimeout(r, 20));
    const second = kernel.handleMessage("second", { sessionId: id, origin: "system", sentAt });
    await new Promise((r) => setTimeout(r, 20));
    expect(kernel.pending.forConversation(id).map((r) => r.flags?.sentAt)).toEqual([sentAt]);
    await drain(first, second);
    // Queued a moment ago, sent eleven minutes ago: told, not run.
    kernel.pending.add(id, "caught up late", [], { via: "discord" }, { owner: true, channel: "discord", sentAt });
    kernel.pending.add(id, "sent just now", [], { via: "discord" }, { owner: true, channel: "discord", sentAt: Date.now() });
    kernel.close();
    kernel = await Kernel.boot({ rootDir: root, inference: held });
    const ran: string[] = [];
    const real = kernel.handleMessage.bind(kernel);
    kernel.handleMessage = (text, opts = {}) => (ran.push(text), real(text, opts));
    kernel.replayQueued();
    await drain();
    expect(ran).toEqual(["sent just now"]);
    const notes = kernel.sessions.get(id).filter((m) => m.role === "assistant").flatMap((m) => m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])));
    expect(notes).toContain("1 queued message was not run after a restart; resend?\n> caught up late");
  });

  it("says in a chat that a restart cut its turn short", async () => {
    const id = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Cut" }).id;
    const turn = kernel.handleMessage("long one", { sessionId: id });
    await new Promise((r) => setTimeout(r, 20));
    // The process stops here; the next one finds the turn still open.
    const open = kernel.settings.get<Record<string, number>>("turns.open");
    expect(Object.keys(open ?? {})).toEqual([id]);
    kernel.close();
    release.forEach((fn) => fn());
    await turn.catch(() => undefined);
    kernel = await Kernel.boot({ rootDir: root, inference: held });
    expect(kernel.markInterrupted()).toEqual([id]);
    const last = kernel.sessions.get(id).at(-1);
    expect(last).toMatchObject({ role: "assistant", content: [{ type: "text", text: "-# interrupted by a restart" }] });
    expect(kernel.markInterrupted()).toEqual([]);
  });
});