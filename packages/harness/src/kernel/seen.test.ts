import { describe, expect, it } from "vitest";

import { SeenPages } from "./seen.js";

/**
 * The agent's last picture of its page stands for the page in an approval
 * only while nothing could have changed it since.
 */
describe("the last picture of a conversation's page", () => {
  const at = { tab: "T1", url: "https://shop.example/cart", moved: 3 };
  const seenAt = (now: { t: number } = { t: 0 }): SeenPages => {
    const seen = new SeenPages(() => now.t);
    seen.run("c1")();
    seen.saw("c1", "PICTURE", at, "shop.example");
    return seen;
  };

  it("stands for the page while the tab, its address, its site and what moved it are the same", () => {
    expect(seenAt().picture("c1", { ...at }, "shop.example")).toBe("PICTURE");
  });

  it("does not stand for another tab, another address or another site", () => {
    const seen = seenAt();
    expect(seen.picture("c1", { ...at, tab: "T2" }, "shop.example")).toBeUndefined();
    expect(seen.picture("c1", { ...at, url: "https://shop.example/checkout" }, "shop.example")).toBeUndefined();
    expect(seen.picture("c1", at, "pay.example")).toBeUndefined();
    expect(seen.picture("c1", undefined, "shop.example")).toBeUndefined();
  });

  it("does not stand once the page moved under it: a navigation, the owner taking the tab or letting it go", () => {
    expect(seenAt().picture("c1", { ...at, moved: 4 }, "shop.example")).toBeUndefined();
  });

  it("goes stale", () => {
    const now = { t: 0 };
    const seen = seenAt(now);
    now.t = 31_000;
    expect(seen.picture("c1", at, "shop.example")).toBeUndefined();
  });

  it("does not stand while another browser call of the chat runs, nor after one answered without a picture", () => {
    const seen = seenAt();
    const ended = seen.run("c1");
    expect(seen.picture("c1", at, "shop.example")).toBeUndefined();
    ended();
    expect(seen.picture("c1", at, "shop.example")).toBeUndefined();
    seen.saw("c1", "AGAIN", at, "shop.example");
    expect(seen.picture("c1", at, "shop.example")).toBe("AGAIN");
    seen.forget("c1");
    expect(seen.picture("c1", at, "shop.example")).toBeUndefined();
  });

  it("is not kept from a call that ended while another, run beside it, still runs", () => {
    const seen = new SeenPages(() => 0);
    const first = seen.run("c1");
    const second = seen.run("c1");
    first();
    seen.saw("c1", "FIRST", at, "shop.example");
    second();
    expect(seen.picture("c1", at, "shop.example")).toBeUndefined();
    // Another chat's calls are its own.
    seen.run("c2")();
    seen.saw("c2", "OTHER", at, "shop.example");
    expect(seen.picture("c2", at, "shop.example")).toBe("OTHER");
  });
});
