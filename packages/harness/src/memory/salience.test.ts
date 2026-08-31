import { describe, expect, it } from "vitest";

import { assessSalience } from "./salience.js";

describe("assessSalience", () => {
  it("extracts a durable fact from 'my X is Y'", () => {
    const r = assessSalience("My timezone is America/New_York.");
    expect(r.verdict).toBe("durable");
    expect(r.candidates).toEqual([
      { key: "timezone", value: "America/New_York", kind: "fact" },
    ]);
  });

  it("flags a preference for confirmation rather than keying it blindly", () => {
    // Keying a preference off its own value produced unsearchable keys like
    // prefers:terse_answers_tag_it_style_and_pin_it, and made every
    // restatement a new row. The confirmer names it instead.
    const r = assessSalience("I prefer dark mode");
    expect(r.verdict).toBe("maybe");
    expect(r.signals).toContain("preference");
    expect(r.candidates).toEqual([]);
  });

  it("flags account info as durable even without a candidate", () => {
    const r = assessSalience("you can reach me at me@example.com");
    expect(r.verdict).toBe("durable");
    expect(r.signals).toContain("account");
  });

  it("treats absolutes as maybe", () => {
    const r = assessSalience("I always drink coffee at 9am");
    expect(r.verdict).toBe("maybe");
    expect(r.signals).toContain("absolute");
  });

  it("treats a bare first-person statement as maybe", () => {
    expect(assessSalience("I am a photographer").verdict).toBe("maybe");
  });

  it("skips non-salient chatter", () => {
    const r = assessSalience("the weather is nice today");
    expect(r.verdict).toBe("skip");
    expect(r.candidates).toEqual([]);
  });
});
