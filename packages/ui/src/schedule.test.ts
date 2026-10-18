import { describe, expect, it } from "vitest";

import { exprOf, recast, shapeOf } from "./schedule.js";

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
    expect(describeCron("0 9 * * *")).toBe("Every day at 09:00");
    expect(describeCron("30 7 * * 1-5")).toBe("Weekdays at 07:30");
    expect(describeCron("0 18 * * 0")).toBe("Every Sunday at 18:00");
    expect(describeCron("0 9 * * 1,3,5")).toBe("Mon, Wed, Fri at 09:00");
    expect(describeCron("0 */6 * * *")).toBe("Every 6 hours, on the hour");
    expect(describeCron("15 */2 * * *")).toBe("Every 2 hours, at 15 past the hour");
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(describeCron("* * * * *")).toBe("Every minute");
    expect(describeCron("0 9 1 * *")).toBe("On day 1 of each month at 09:00");
    expect(describeCron("0 9 * 6 *")).toBeNull();
    expect(describeCron("nonsense")).toBeNull();
  });
});
