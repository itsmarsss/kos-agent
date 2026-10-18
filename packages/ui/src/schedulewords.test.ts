import { describe, expect, it } from "vitest";

import { agoWords, inWords, runDays, sizeWords } from "./schedulewords.js";

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

  it("says how far off and how long ago in a word or two", () => {
    const now = 1_000_000_000_000;
    expect(inWords(now + 20 * 60_000, now)).toBe("in 20m");
    expect(inWords(now + 5 * 3_600_000, now)).toBe("in 5h");
    expect(inWords(now + 3 * 86_400_000, now)).toBe("in 3d");
    expect(inWords(now - 1, now)).toBe("now");
    expect(agoWords(now - 30_000, now)).toBe("just now");
    expect(agoWords(now - 6 * 3_600_000, now)).toBe("6h ago");
    expect(agoWords(now - 2 * 86_400_000, now)).toBe("2d ago");
  });

  it("writes a size as people read one", () => {
    expect(sizeWords(61)).toBe("61 B");
    expect(sizeWords(2300)).toBe("2.2 KB");
    expect(sizeWords(140_000)).toBe("137 KB");
    expect(sizeWords(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
