import { describe, expect, it } from "vitest";

import { formatDuration, waitWords } from "./duration.js";

describe("how long a step took", () => {
  it("says milliseconds, tenths, seconds, minutes and hours", () => {
    expect(formatDuration(420)).toBe("420ms");
    expect(formatDuration(2_400)).toBe("2.4s");
    expect(formatDuration(9_960)).toBe("9s");
    expect(formatDuration(12_300)).toBe("12s");
    expect(formatDuration(64_000)).toBe("1m 04s");
    expect(formatDuration(72_900)).toBe("1m 12s");
    expect(formatDuration(3_840_000)).toBe("1h 04m");
    expect(formatDuration(-5)).toBe("0ms");
  });

  it("counts a live step in whole seconds", () => {
    expect(formatDuration(400, true)).toBe("0s");
    expect(formatDuration(3_700, true)).toBe("3s");
    expect(formatDuration(64_200, true)).toBe("1m 04s");
  });

  it("says the wait on the owner apart", () => {
    expect(waitWords(40_000)).toBe("waited 40s for you");
    expect(waitWords(125_000)).toBe("waited 2m for you");
    expect(waitWords(3_900_000)).toBe("waited 1h 5m for you");
  });
});
