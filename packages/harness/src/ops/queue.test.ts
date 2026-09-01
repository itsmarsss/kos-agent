import { describe, expect, it } from "vitest";

import { SHARED_LANE, WorkQueue } from "./queue.js";

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Lanes.
 *
 * This was one serial queue for the whole process, which is more
 * serialisation than the problem needs: a long turn in one chat blocked every
 * other chat, every cron job and every approval, and the owner saw nothing
 * happen with no sign why.
 */
describe("the work queue", () => {
  it("runs one lane in order", async () => {
    const q = new WorkQueue();
    const order: string[] = [];
    const a = q.enqueue(async () => {
      await tick(20);
      order.push("a");
    }, "chat");
    const b = q.enqueue(() => {
      order.push("b");
    }, "chat");
    await Promise.all([a, b]);
    expect(order).toEqual(["a", "b"]);
  });

  /* The point of the change: two chats are not each other's problem. */
  it("runs different lanes at the same time", async () => {
    const q = new WorkQueue();
    const order: string[] = [];
    const slow = q.enqueue(async () => {
      await tick(40);
      order.push("slow");
    }, "chat-one");
    const quick = q.enqueue(() => {
      order.push("quick");
    }, "chat-two");
    await Promise.all([slow, quick]);
    // The quick one did not wait for the slow one.
    expect(order).toEqual(["quick", "slow"]);
  });

  it("keeps a lane going after one of its tasks throws", async () => {
    const q = new WorkQueue();
    const failed = q.enqueue(() => {
      throw new Error("no");
    }, "chat");
    await expect(failed).rejects.toThrow("no");
    await expect(q.enqueue(() => "fine", "chat")).resolves.toBe("fine");
  });

  it("reports depth per lane, which is what 'am I behind' means", async () => {
    const q = new WorkQueue();
    const held = q.enqueue(() => tick(30), "chat-one");
    q.enqueue(() => tick(30), "chat-one");
    q.enqueue(() => tick(1), "chat-two");
    expect(q.depthOf("chat-one")).toBe(2);
    expect(q.depthOf("chat-two")).toBe(1);
    expect(q.depthOf("chat-three")).toBe(0);
    expect(q.depth).toBe(3);
    await held;
    await q.drain();
    expect(q.depth).toBe(0);
  });

  it("forgets a lane once it has drained, so lanes do not accumulate", async () => {
    const q = new WorkQueue();
    await q.enqueue(() => "done", "one-off");
    await tick(5);
    expect(q.depthOf("one-off")).toBe(0);
    // A later task in the same lane still runs rather than waiting on a
    // chain that no longer exists.
    await expect(q.enqueue(() => "again", "one-off")).resolves.toBe("again");
  });

  it("defaults to the shared lane", async () => {
    const q = new WorkQueue();
    const running = q.enqueue(() => tick(20));
    expect(q.depthOf(SHARED_LANE)).toBe(1);
    await running;
  });
});
