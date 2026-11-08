import { describe, expect, it } from "vitest";

import { Page, Stopped, type Session } from "./page.js";

type Handler = (params: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;

/** A tab's commands answered here: by the handlers given, the rest with nothing; each call kept. */
function tab(handlers: Record<string, Handler>): { session: Session; calls: { method: string; params: Record<string, unknown> }[] } {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const session: Session = {
    send: async (method, params = {}) => {
      calls.push({ method, params });
      const handler = handlers[method];
      return handler ? handler(params) : {};
    },
  };
  return { session, calls };
}

const FRAME = { frameTree: { frame: { id: "F", loaderId: "L", url: "https://shop.example/" } } };
/** What the page itself finds to index: nothing, which is enough to see where it was looked from. */
const NOTHING = { result: [{ name: "kos", value: { value: JSON.stringify({ items: [], total: 0 }) } }] };
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

describe("KOS's own world in a page", () => {
  it("is asked for again after a Stop cut its making short, not taken to be missing", async () => {
    let made = 0;
    const { session, calls } = tab({
      "Page.getFrameTree": () => FRAME,
      "Page.createIsolatedWorld": () => (++made === 1 ? never() : { executionContextId: 9 }),
      "Runtime.evaluate": (p) => (p["contextId"] === 9 ? { result: { objectId: "found" } } : { result: { value: "complete" } }),
      "Runtime.getProperties": () => NOTHING,
    });
    const page = new Page(session);
    await page.ready();
    const stop = new AbortController();
    const pressing = page.step({ press: "Enter" }, stop.signal);
    setTimeout(() => stop.abort(), 50);
    await expect(pressing).rejects.toBeInstanceOf(Stopped);
    await page.index();
    expect(made).toBe(2);
    // Read from that world, not from the whole tree, as a tab with no world of KOS's own is.
    expect(calls.some((c) => c.method === "Accessibility.getFullAXTree")).toBe(false);
  });

  it("is asked for again after a failure, and not again where the browser refuses it", async () => {
    for (const [error, asked] of [[Object.assign(new Error("Cannot find context"), {}), 2], [Object.assign(new Error("not passed on"), { code: "method" }), 1]] as const) {
      let made = 0;
      const { session } = tab({
        "Page.getFrameTree": () => FRAME,
        "Page.createIsolatedWorld": () => {
          if (++made === 1) throw error;
          return { executionContextId: 9 };
        },
        "Runtime.evaluate": (p) => (p["contextId"] === 9 ? { result: { objectId: "found" } } : { result: { value: "complete" } }),
        "Runtime.getProperties": () => NOTHING,
        "Accessibility.getFullAXTree": () => ({ nodes: [] }),
      });
      const page = new Page(session);
      await page.ready();
      await page.index();
      await page.index();
      expect(made).toBe(asked);
    }
  });
});

describe("a Stop part way through a step", () => {
  /** A page with one element at every selector, a box at the top left, under nothing. */
  const shop = (more: Record<string, Handler> = {}): ReturnType<typeof tab> =>
    tab({
      "Page.getFrameTree": () => FRAME,
      "Runtime.evaluate": () => ({ result: { objectId: "el", value: "complete" } }),
      "DOM.describeNode": () => ({ node: { backendNodeId: 10 } }),
      "DOM.getContentQuads": () => ({ quads: [[0, 0, 20, 0, 20, 20, 0, 20]] }),
      "DOM.getNodeForLocation": () => ({ backendNodeId: 10 }),
      ...more,
    });

  it("lets go of the button of a drag stopped between its press and its release", async () => {
    const stop = new AbortController();
    const { session, calls } = shop({
      "Input.dispatchMouseEvent": (p) => {
        if (p["type"] === "mouseMoved" && p["buttons"] === 1) stop.abort();
        return {};
      },
    });
    const page = new Page(session);
    await page.ready();
    await expect(page.step({ drag: { from: "#card", to: "#done" } }, stop.signal)).rejects.toBeInstanceOf(Stopped);
    const mouse = calls.filter((c) => c.method === "Input.dispatchMouseEvent").map((c) => c.params["type"]);
    expect(mouse.indexOf("mouseReleased")).toBeGreaterThan(mouse.indexOf("mousePressed"));
    expect(calls.at(-1)).toEqual({ method: "Input.setInterceptDrags", params: { enabled: false } });
  });

  it("releases what a command no longer waited for brings back, once it does", async () => {
    let answer: (r: Record<string, unknown>) => void = () => undefined;
    const { session, calls } = shop({
      "Runtime.evaluate": (p) =>
        String(p["expression"]).includes("present") ? new Promise((r) => (answer = r)) : { result: { objectId: "el", value: "complete" } },
    });
    const page = new Page(session);
    await page.ready();
    const stop = new AbortController();
    const waiting = page.step({ wait: { text: "never there" } }, stop.signal);
    await new Promise((r) => setTimeout(r, 20));
    stop.abort();
    await expect(waiting).rejects.toBeInstanceOf(Stopped);
    answer({ result: { objectId: "late" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.filter((c) => c.method === "Runtime.releaseObject")).toEqual([{ method: "Runtime.releaseObject", params: { objectId: "late" } }]);
  });
});
