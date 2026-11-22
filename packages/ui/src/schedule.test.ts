import { describe, expect, it } from "vitest";

import { cronProblem, exprOf, KINDS, recast, scheduleWords, shapeOf } from "./schedule.js";

describe("a schedule as a shape", () => {
  it("reads the shapes the picker writes, and writes them back the same", () => {
    const lines: Record<string, unknown> = {
      "0 9 * * *": { kind: "daily", time: "09:00" },
      "30 7 * * 1-5": { kind: "weekdays", time: "07:30" },
      "0 18 * * 0": { kind: "weekly", days: [0], time: "18:00" },
      "15 16 * * 1,3,5": { kind: "weekly", days: [1, 3, 5], time: "16:15" },
      "0 */6 * * *": { kind: "hourly", every: 6, minute: 0 },
      "15 */2 * * *": { kind: "hourly", every: 2, minute: 15 },
      "*/15 * * * *": { kind: "minutes", every: 15 },
      "0 9 1 * *": { kind: "monthly", day: 1, time: "09:00" },
    };
    for (const [line, shape] of Object.entries(lines)) {
      expect(shapeOf(line), line).toEqual(shape);
      expect(exprOf(shapeOf(line)), line).toBe(line);
    }
  });

  it("keeps anything else as the text it is", () => {
    for (const line of ["0 9 * 6 *", "0 9 1-15 * *", "0 9 * * 1-3", "* * * * *", "nonsense", "60 9 * * *", "0 25 * * *", "*/0 * * * *", "0 9 32 * *"]) {
      expect(shapeOf(line), line).toEqual({ kind: "custom", expr: line });
    }
  });

  it("carries the time and the days over when the kind changes", () => {
    const weekdays = shapeOf("30 7 * * 1-5");
    expect(recast(weekdays, "daily")).toEqual({ kind: "daily", time: "07:30" });
    expect(recast(weekdays, "weekly")).toEqual({ kind: "weekly", days: [1, 2, 3, 4, 5], time: "07:30" });
    expect(recast(weekdays, "monthly")).toEqual({ kind: "monthly", day: 1, time: "07:30" });
    expect(recast(weekdays, "hourly")).toEqual({ kind: "hourly", every: 6, minute: 0 });
    expect(recast(weekdays, "custom")).toEqual({ kind: "custom", expr: "30 7 * * 1-5" });
    expect(recast(shapeOf("*/15 * * * *"), "daily")).toEqual({ kind: "daily", time: "09:00" });
    // A weekly with no day chosen is not a line yet.
    expect(exprOf({ kind: "weekly", days: [], time: "09:00" })).toBe("");
  });
});

describe("describeCron", () => {
  it("says a line in words, or nothing for a line it cannot read", async () => {
    const { describeCron } = await import("./schedule.js");
    expect(describeCron("0 9 * * *", "en-GB")).toBe("Every day at 09:00");
    expect(describeCron("30 7 * * 1-5", "en-GB")).toBe("Weekdays at 07:30");
    // On the reader's own clock: no leading zero where the day has two halves.
    expect(describeCron("30 7 * * 1-5", "en-US")).toMatch(/^Weekdays at 7:30\sAM$/);
    expect(describeCron("0 18 * * 0", "en-GB")).toBe("Every Sunday at 18:00");
    expect(describeCron("0 9 * * 1,3,5", "en-GB")).toBe("Mon, Wed, Fri at 09:00");
    expect(describeCron("0 */6 * * *")).toBe("Every 6 hours, on the hour");
    expect(describeCron("15 */2 * * *")).toBe("Every 2 hours, at 15 past the hour");
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(describeCron("* * * * *")).toBe("Every minute");
    expect(describeCron("0 9 1 * *", "en-GB")).toBe("On day 1 of each month at 09:00");
    expect(describeCron("0 9 * 6 *")).toBeNull();
    expect(describeCron("nonsense")).toBeNull();
  });
});

describe("scheduleWords", () => {
  it("reads a schedule back in words, never as its cron line", () => {
    expect(scheduleWords("0 8 * * 1-5", "en-US")).toBe("Weekdays at 8:00 AM");
    expect(scheduleWords("7 3 1,15 2 *")).toBe("On a custom schedule");
    expect(scheduleWords(null)).toBe("When asked");
  });
});

describe("the schedule builder's check of a line", () => {
  it("takes every line the builder writes, and the usual hand-written ones", () => {
    for (const k of KINDS) expect(cronProblem(exprOf(recast({ kind: "daily", time: "08:30" }, k.kind))), k.kind).toBeNull();
    for (const line of ["0 9 * * *", "*/15 * * * *", "0 9-17 * * 1-5", "0 0 1,15 * *", "30 6 * jan-mar mon", "0 */2 * * 0,6", "0 0 * * 7"]) {
      expect(cronProblem(line), line).toBeNull();
    }
  });

  it("names the part that is wrong, with the numbers it takes", () => {
    expect(cronProblem("0 99 * * *")).toBe("The hour must be 0 to 23, *, or a range such as 0-2.");
    expect(cronProblem("60 9 * * *")).toMatch(/^The minute must be 0 to 59/);
    expect(cronProblem("0 9 32 * *")).toMatch(/^The day of the month must be 1 to 31/);
    expect(cronProblem("0 9 * 13 *")).toMatch(/^The month must be 1 to 12/);
    expect(cronProblem("0 9 * * 8")).toMatch(/^The day of the week must be 0 to 7/);
    expect(cronProblem("*/0 * * * *")).toMatch(/^The minute/);
    expect(cronProblem("0 9-x * * *")).toMatch(/^The hour/);
  });

  it("says how many parts a line has when it has not five, and asks for a time when empty", () => {
    expect(cronProblem("0 9 * *")).toBe("A schedule line has five parts: minute, hour, day of the month, month, day of the week. This has 4.");
    expect(cronProblem("whenever")).toMatch(/This has 1\.$/);
    expect(cronProblem("  ")).toBe("Pick when it runs.");
  });
});
