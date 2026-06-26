import { describe, expect, it } from "vitest";

import { WorkQueue } from "./queue.js";

describe("WorkQueue", () => {
  it("runs tasks serially in enqueue order", async () => {
    const q = new WorkQueue();
    const order: string[] = [];
    const task = (id: number) => async () => {
      order.push(`s${id}`);
      await Promise.resolve();
      await Promise.resolve();
      order.push(`e${id}`);
      return id;
    };
    const results = await Promise.all([q.enqueue(task(0)), q.enqueue(task(1))]);
    expect(results).toEqual([0, 1]);
    expect(order).toEqual(["s0", "e0", "s1", "e1"]); // no interleaving
  });

  it("keeps the chain alive after a task throws", async () => {
    const q = new WorkQueue();
    const failed = q.enqueue(async () => {
      throw new Error("boom");
    });
    const ok = q.enqueue(async () => "ok");
    await expect(failed).rejects.toThrow("boom");
    await expect(ok).resolves.toBe("ok");
  });

  it("tracks depth and drains", async () => {
    const q = new WorkQueue();
    q.enqueue(async () => Promise.resolve());
    q.enqueue(async () => Promise.resolve());
    expect(q.depth).toBe(2);
    await q.drain();
    expect(q.depth).toBe(0);
  });
});
