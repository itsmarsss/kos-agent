import { describe, expect, it } from "vitest";

import { frameOf, keep, picturesOf, showable, type Pictured } from "./frames.js";

/** The side panel's step pictures: read off the line, kept the newest few, and never one of a hidden site. */
describe("the side panel's step pictures", () => {
  it("reads a running step's picture, and nothing from a status without one", () => {
    expect(frameOf({ frame: { id: 4, image: "AAA", mediaType: "image/jpeg", site: "shop.test" } })).toEqual([4, { image: "AAA", site: "shop.test" }]);
    expect(frameOf({ frame: { id: 4, image: "AAA" } })).toEqual([4, { image: "AAA" }]);
    expect(frameOf({ story: "› Click" })).toBeUndefined();
    expect(frameOf({ frame: { id: "4", image: "AAA" } })).toBeUndefined();
  });

  it("reads the pictures a chat came with, each with its site", () => {
    expect(picturesOf({ pictures: { 3: "P3", 6: "P6", x: "bad" }, sites: { 6: "shop.test" } })).toEqual([
      [3, { image: "P3" }],
      [6, { image: "P6", site: "shop.test" }],
    ]);
    expect(picturesOf({})).toEqual([]);
  });

  it("keeps the newest pictures and lets the oldest go past the cap", () => {
    let cache: Map<number, Pictured> = new Map();
    for (let i = 1; i <= 5; i++) cache = keep(cache, [[i, { image: `P${i}` }]], 3);
    expect([...cache.keys()]).toEqual([3, 4, 5]);
    // One sent again counts as new.
    cache = keep(cache, [[3, { image: "P3" }]], 3);
    expect([...cache.keys()]).toEqual([4, 5, 3]);
  });

  it("never draws a picture of a site the owner hid, or of a subdomain of one", () => {
    const hidden = ["bank.test"];
    expect(showable({ image: "A", site: "bank.test" }, hidden)).toBe(false);
    expect(showable({ image: "A", site: "www.bank.test" }, hidden)).toBe(false);
    expect(showable({ image: "A", site: "shop.test" }, hidden)).toBe(true);
    // A screen's picture names no site.
    expect(showable({ image: "A" }, hidden)).toBe(true);
    expect(showable(undefined, hidden)).toBe(false);
  });
});
