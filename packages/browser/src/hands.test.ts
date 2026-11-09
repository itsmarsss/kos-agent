import { afterEach, describe, expect, it, vi } from "vitest";

import { act, opensElsewhere, visit, type Tab } from "./hands.js";
import type { Page } from "./page.js";

/** A page that counts its round trips: where it is, and what a look asks of it. */
function fakeTab(urls: string[], onStep: (signal?: AbortSignal, step?: unknown) => void = () => undefined) {
  const asked = { whereAmI: 0, index: 0, capture: 0, steps: 0 };
  let at = 0;
  const page = {
    run: <T>(work: () => Promise<T>) => work(),
    ready: async () => undefined,
    release: async () => undefined,
    step: async (step: unknown, signal?: AbortSignal) => {
      asked.steps++;
      onStep(signal, step);
      at = Math.min(at + 1, urls.length - 1);
      return "Clicked Next";
    },
    takeNotes: () => [],
    whereAmI: async () => {
      asked.whereAmI++;
      return { url: urls[at]!, title: "Shop" };
    },
    index: async () => {
      asked.index++;
      return { index: { lines: ["@e1 button Next"], total: 1 }, unread: [] };
    },
  } as unknown as Page;
  const tab: Tab = {
    page,
    capture: async () => {
      asked.capture++;
      return "SU1H";
    },
  };
  return { tab, asked };
}

describe("a run of steps", () => {
  it("asks the tab where it is twice, not three times: before, and beside the look", async () => {
    const { tab, asked } = fakeTab(["http://shop.test/1", "http://shop.test/2"]);
    const seen = await act(tab, [{ click: "@e1" } as never], "look");
    expect(asked.whereAmI).toBe(2);
    expect(asked.capture).toBe(1);
    expect(seen.text).toMatch(/^Done: Clicked Next\. Now at http:\/\/shop\.test\/2\.\nTitle: Shop\nURL: http:\/\/shop\.test\/2/);
    expect(seen.images).toHaveLength(1);
  });

  it("still says where a run that does not look ended up", async () => {
    const { tab, asked } = fakeTab(["http://shop.test/1", "http://shop.test/2"]);
    const seen = await act(tab, [{ click: "@e1" } as never], "none");
    expect(asked.whereAmI).toBe(2);
    expect(asked.capture).toBe(0);
    expect(seen.text).toBe("Done: Clicked Next. Now at http://shop.test/2.");
  });

  it("takes no further step once the owner has pressed Stop", async () => {
    const stop = new AbortController();
    const { tab, asked } = fakeTab(["http://shop.test/1", "http://shop.test/2"], () => stop.abort());
    const steps = [{ click: "@e1" }, { wait: 1000 }, { click: "@e2" }] as never[];
    await expect(act(tab, steps, "look", stop.signal)).rejects.toThrow(/^Done: Clicked Next\. Stopped by the owner before step 2\.$/);
    expect(asked.steps).toBe(1);
    expect(asked.capture).toBe(0);
  });

  it("hands the owner's Stop to the step under way, as the page's own second argument", async () => {
    const stop = new AbortController();
    const given: (AbortSignal | undefined)[] = [];
    const { tab } = fakeTab(["http://shop.test/1"], (signal) => given.push(signal));
    await act(tab, [{ click: "@e1" }] as never[], "none", stop.signal);
    expect(given).toEqual([stop.signal]);
  });

  it("tells each step the one to come after it, and the last that none does", async () => {
    const { tab } = fakeTab(["http://shop.test/1"]);
    const nexts: unknown[] = [];
    const page = tab.page as unknown as { step: (step: unknown, signal?: AbortSignal, next?: unknown) => Promise<string> };
    page.step = async (_step, _signal, next) => (nexts.push(next), "done");
    const fill = (target: string) => ({ fill: { target, text: "x" } });
    await act(tab, [fill("#a"), fill("#b"), { click: "#go" }] as never[], "none");
    expect(nexts).toEqual([fill("#b"), { click: "#go" }, undefined]);
  });

  it("claims a Stop ended only a wait where it was; input already sent may have finished", async () => {
    for (const [step, said] of [
      [{ click: "@e1" }, "Stopped by the owner; step 1 may have finished in the page."],
      [{ hover: "@e1" }, "Stopped by the owner; step 1 may have finished in the page."],
      [{ wait: { text: "Done" } }, "Stopped by the owner during step 1."],
    ] as const) {
      const stop = new AbortController();
      const { tab } = fakeTab(["http://shop.test/1"], () => {
        stop.abort();
        throw new Error("stopped");
      });
      await expect(act(tab, [step] as never[], "none", stop.signal)).rejects.toThrow(said);
    }
  });

  describe("waits", () => {
    afterEach(() => void vi.useRealTimers());

    it("draws a wait for the page from the call's one budget, and stops when it is spent", async () => {
      vi.useFakeTimers();
      const limits: number[] = [];
      // Each wait for the page takes as long as it was allowed.
      const { tab } = fakeTab(["http://shop.test/1"], (_signal, step) => {
        const ms = (step as { wait: { ms: number } }).wait.ms;
        limits.push(ms);
        vi.advanceTimersByTime(ms);
      });
      const waits = Array.from({ length: 5 }, () => ({ wait: { text: "Done" } })) as never[];
      await expect(act(tab, waits, "none")).rejects.toThrow(/Step 5 \(wait\) failed: no time was left to wait \(one call waits at most 60s in all\)/);
      expect(limits).toEqual([15_000, 15_000, 15_000, 15_000]);
    });

    it("gives back what a wait for the page did not use", async () => {
      const limits: number[] = [];
      const { tab } = fakeTab(["http://shop.test/1"], (_signal, step) => void limits.push((step as { wait: { ms: number } }).wait.ms));
      await act(tab, Array.from({ length: 6 }, () => ({ wait: { text: "Done" } })) as never[], "none");
      expect(limits.every((ms) => ms >= 14_900)).toBe(true);
    });
  });
});

describe("a run allowed on one site alone", () => {
  it("runs every step while the tab stays on the site", async () => {
    const { tab, asked } = fakeTab(["http://shop.test/1", "http://shop.test/2", "http://shop.test/3"]);
    const seen = await act(tab, [{ click: "@e1" } as never, { click: "@e2" } as never, { click: "@e3" } as never], "none", undefined, { site: "shop.test" });
    expect(asked.steps).toBe(3);
    expect(seen.text).toMatch(/^Done: Clicked Next; Clicked Next; Clicked Next\./);
  });

  it("stops before the next step once a click has taken the tab to another site", async () => {
    const { tab, asked } = fakeTab(["http://shop.test/cart", "https://bank.example/transfer"]);
    const run = act(tab, [{ click: "@e1" } as never, { click: "@e7" } as never], "none", undefined, { site: "shop.test" });
    await expect(run).rejects.toThrow(/^Done: Clicked Next\. The tab left shop\.test for bank\.example, .*step 2 and those after it were not run: they need the owner's OK/);
    expect(asked.steps).toBe(1);
  });

  it("names a run that opens another site, so it is asked about before it starts", () => {
    expect(opensElsewhere({ actions: [{ open: "https://bank.example/transfer" }, { click: "@e1" }] }, "shop.test")).toBe(true);
    expect(opensElsewhere({ actions: [{ open: "shop.test/cart" }, { click: "@e1" }] }, "shop.test")).toBe(false);
    expect(opensElsewhere({ actions: [{ open: "file:///etc/passwd" }] }, "shop.test")).toBe(true);
    expect(opensElsewhere({ actions: [{ click: "@e1" }, { go: "back" }] }, "shop.test")).toBe(false);
  });
});

describe("a visit to several pages", () => {
  it("says it ended on a page it has no picture of when the last capture failed", async () => {
    const { tab } = fakeTab(["http://shop.test/1"]);
    const page = tab.page as unknown as { goto: (url: string) => Promise<{ stillLoading: boolean }> };
    page.goto = async () => ({ stillLoading: false });
    let captures = 0;
    const failing: Tab = { page: tab.page, capture: async () => (++captures === 2 ? undefined : "SU1H") };
    const seen = await visit(failing, ["http://shop.test/1", "http://shop.test/2"], { then: "look" });
    expect(seen.images).toHaveLength(1);
    expect(seen.endUnseen).toBe(true);
    captures = 0;
    const whole = await visit({ page: tab.page, capture: async () => "SU1H" }, ["http://shop.test/1", "http://shop.test/2"], { then: "look" });
    expect(whole.images).toHaveLength(2);
    expect(whole.endUnseen).toBeUndefined();
  });
});
