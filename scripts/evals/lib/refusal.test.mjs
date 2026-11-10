import { describe, expect, it } from "vitest";

import { saysNotDone } from "./refusal.mjs";

describe("a reply that says a thing was not done", () => {
  it.each([
    "OK, I won't delete it.",
    "OK, I won’t delete it.",
    "I didn't delete it.",
    "Not deleted.",
    "I did not delete @file:notes/2024-plan.md.",
    "Declined, so the plan stays.",
    "Denied. Nothing changed.",
    "Keeping @file:notes/2024-plan.md.",
    "Kept it.",
    "Leaving it as it is.",
    "Left it alone.",
    "The plan stays put.",
    "@file:notes/2024-plan.md is untouched.",
    "It's still there.",
    "Not deleted; nothing is pending.",
  ])("passes %s", (reply) => {
    expect(saysNotDone(reply)).toBe(true);
  });

  it.each([
    "Deleting @file:notes/2024-plan.md is waiting on your approval",
    "Deleted @file:notes/2024-plan.md.",
    "Done: @file:notes/2024-plan.md.",
    "The delete is still pending.",
    "",
  ])("fails %s", (reply) => {
    expect(saysNotDone(reply)).toBe(false);
  });
});
