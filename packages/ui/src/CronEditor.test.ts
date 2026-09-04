import { describe, expect, it } from "vitest";

import { describeCron } from "./CronEditor.js";

/**
 * Five numbers and three stars is a format you either know or you do not.
 * Getting it wrong means a job that runs at a time you did not intend, with
 * nothing on the screen to say so.
 */
describe("reading a cron line back in words", () => {
  it("reads a daily time", () => {
    expect(describeCron("0 9 * * *")).toBe("Every day at 09:00");
    expect(describeCron("30 6 * * *")).toBe("Every day at 06:30");
  });

  it("reads a weekday", () => {
    expect(describeCron("0 9 * * 1")).toBe("Every Monday at 09:00");
    expect(describeCron("0 17 * * 5")).toBe("Every Friday at 17:00");
  });

  it("reads intervals", () => {
    expect(describeCron("*/5 * * * *")).toBe("Every 5 minutes");
    expect(describeCron("0 */6 * * *")).toBe("Every 6 hours, at 00 past");
    expect(describeCron("* * * * *")).toBe("Every minute");
  });

  it("reads a day of the month", () => {
    expect(describeCron("0 8 1 * *")).toBe("On day 1 of each month at 08:00");
  });

  it("says nothing rather than guessing", () => {
    // A confident wrong reading is worse than none: the owner would trust it.
    expect(describeCron("0 9 * * 1,3,5")).toBeNull();
    expect(describeCron("0 9 1-7 * *")).toBeNull();
    expect(describeCron("nonsense")).toBeNull();
    expect(describeCron("0 9 * *")).toBeNull();
    expect(describeCron("")).toBeNull();
  });
});
