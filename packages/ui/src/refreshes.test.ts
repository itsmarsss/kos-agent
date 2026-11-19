import { describe, expect, it } from "vitest";

import { Refreshes } from "./refreshes.js";

describe("the dashboard's refreshes", () => {
  it("apply only the newest one's answers, and say when one is still out", () => {
    const refreshes = new Refreshes();
    expect(refreshes.busy).toBe(false);
    const poll = refreshes.begin();
    expect(refreshes.busy).toBe(true);
    // The owner decides while the poll stalls: decide's refresh is begun later and answers first.
    const decided = refreshes.begin();
    expect(decided.newest()).toBe(true);
    decided.end();
    expect(refreshes.busy).toBe(true);
    // The stalled poll lands last: what it read is older, and is not applied.
    expect(poll.newest()).toBe(false);
    poll.end();
    poll.end();
    expect(refreshes.busy).toBe(false);
  });
});
