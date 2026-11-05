import { describe, expect, it } from "vitest";

import { groundedIn } from "./grounded.js";

describe("groundedIn", () => {
  it("matches a claim to the owner's words however it is worded", () => {
    expect(groundedIn("The owner is vegetarian", "I'm vegetarian and allergic to peanuts")).toBe(true);
    expect(groundedIn("Owner's allergic to peanut", "I'm vegetarian and allergic to peanuts")).toBe(true);
    expect(groundedIn("Prefers replies under 150 words", "keep replies under 150 words please")).toBe(true);
  });

  it("refuses a claim that says more than was said", () => {
    expect(groundedIn("The owner prefers dark roast coffee", "summarize this page")).toBe(false);
    expect(groundedIn("The owner is vegan", "I'm vegetarian")).toBe(false);
    expect(groundedIn("The owner prefers metric units", "use metric")).toBe(false);
  });

  it("refuses a claim with nothing distinctive in it", () => {
    expect(groundedIn("The owner", "the owner")).toBe(false);
  });
});
