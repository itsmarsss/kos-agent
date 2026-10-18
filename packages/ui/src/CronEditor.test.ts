import { describe, expect, it } from "vitest";

import { TEMPLATES } from "./CronEditor.js";
import { describeCron } from "./schedule.js";

describe("the jobs offered to start from", () => {
  it("each has a schedule that reads back, and a prompt that reaches the owner", () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual(["brief", "review", "watch"]);
    for (const t of TEMPLATES) {
      expect(describeCron(t.schedule)).not.toBeNull();
      expect(t.name.length).toBeGreaterThan(0);
      // A prompt reaches the owner through notify; a fixed watch tells them itself.
      if (t.actions) expect(t.actions[0]).toMatchObject({ tool: "browser.watch", args: { tell: true } });
      else expect(t.prompt).toContain("notify");
    }
    expect(describeCron(TEMPLATES[0]!.schedule)).toBe("Weekdays at 07:30");
    expect(describeCron(TEMPLATES[2]!.schedule)).toBe("Every 6 hours, on the hour");
  });
});

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
    expect(describeCron("0 */6 * * *")).toBe("Every 6 hours, on the hour");
    expect(describeCron("15 */2 * * *")).toBe("Every 2 hours, at 15 past the hour");
    expect(describeCron("0 */1 * * *")).toBe("Every hour, on the hour");
    expect(describeCron("* * * * *")).toBe("Every minute");
  });

  it("reads a day of the month", () => {
    expect(describeCron("0 8 1 * *")).toBe("On day 1 of each month at 08:00");
  });

  it("says nothing rather than guessing", () => {
    // A confident wrong reading is worse than none: the owner would trust it.
    expect(describeCron("0 9 * * 1,3,5")).toBe("Mon, Wed, Fri at 09:00");
    expect(describeCron("0 9 1-7 * *")).toBeNull();
    expect(describeCron("nonsense")).toBeNull();
    expect(describeCron("0 9 * *")).toBeNull();
    expect(describeCron("")).toBeNull();
  });
});
