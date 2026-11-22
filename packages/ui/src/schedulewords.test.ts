import { describe, expect, it } from "vitest";

import { jobTitle, lastRunWords, runDays } from "./schedulewords.js";

describe("schedule words", () => {
  it("reads which weekdays a cron line runs on", () => {
    expect([...runDays("0 18 * * 0")!]).toEqual([0]);
    expect([...runDays("30 7 * * 1-5")!]).toEqual([1, 2, 3, 4, 5]);
    expect([...runDays("0 9 * * 1,3,5")!]).toEqual([1, 3, 5]);
    expect([...runDays("0 */6 * * *")!]).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect([...runDays("0 0 * * */2")!]).toEqual([0, 2, 4, 6]);
  });

  it("has no weekdays for a line tied to dates, or one it cannot read", () => {
    expect(runDays("0 9 1 * *")).toBeNull();
    expect(runDays("0 9 * 6 *")).toBeNull();
    expect(runDays("0 9 * * 9")).toBeNull();
    expect(runDays("nonsense")).toBeNull();
  });

  it("names a schedule by the one name it goes by, and says when it last ran", () => {
    expect([jobTitle("kos.memory"), jobTitle("kos.dream"), jobTitle("blob.plant-watcher"), jobTitle("Morning brief")]).toEqual(["Memory: Read", "Memory: Tidy", "Plant watcher", "Morning brief"]);
    const now = 1_000_000_000_000;
    expect(lastRunWords(now - 6 * 3_600_000, now)).toBe("6h ago");
    expect(lastRunWords(null, now)).toBe("Never run");
  });
});
