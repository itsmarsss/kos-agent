import { describe, expect, it } from "vitest";

import { act, type Tab } from "./hands.js";
import type { Page } from "./page.js";

/** A page that counts its round trips: where it is, and what a look asks of it. */
function fakeTab(urls: string[]) {
  const asked = { whereAmI: 0, index: 0, capture: 0 };
  let at = 0;
  const page = {
    run: <T>(work: () => Promise<T>) => work(),
    ready: async () => undefined,
    release: async () => undefined,
    step: async () => {
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
});
