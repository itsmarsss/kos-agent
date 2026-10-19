import { describe, expect, it } from "vitest";

import { tablesToCode } from "./tables.js";

describe("tablesToCode", () => {
  it("lines a pipe table up in a code block and leaves the rest alone", () => {
    const text = "**Weekly split**\n| Day | Workout | Duration |\n|---|---|---|\n| 1 | Push (Heavy) | 50–60 min |\n| 6–7 | Rest | 0–15 min |\nThat is the week.";
    expect(tablesToCode(text)).toBe(
      ["**Weekly split**", "```", "Day  Workout       Duration", "---  ------------  ---------", "1    Push (Heavy)  50–60 min", "6–7  Rest          0–15 min", "```", "That is the week."].join("\n"),
    );
    // Not a table: a lone pipe line, or a table already in code.
    expect(tablesToCode("a | b\nnothing")).toBe("a | b\nnothing");
    expect(tablesToCode("```\n| a | b |\n|---|---|\n```")).toBe("```\n| a | b |\n|---|---|\n```");
  });
});
