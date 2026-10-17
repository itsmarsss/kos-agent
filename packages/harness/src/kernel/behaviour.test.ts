import { describe, expect, it } from "vitest";

import {
  BEHAVIOUR_DEFAULTS,
  parseBehaviour,
} from "./behaviour.js";

describe("behaviour settings", () => {
  it("is the defaults when nothing is stored", () => {
    expect(parseBehaviour(undefined)).toEqual(BEHAVIOUR_DEFAULTS);
    expect(parseBehaviour(null)).toEqual(BEHAVIOUR_DEFAULTS);
    expect(parseBehaviour("nonsense")).toEqual(BEHAVIOUR_DEFAULTS);
  });

  it("keeps what it was given", () => {
    const saved = parseBehaviour({ autoFix: true, maxSteps: 30 });
    expect(saved.autoFix).toBe(true);
    expect(saved.maxSteps).toBe(30);
    // Everything unmentioned still has a value, so a partial save cannot
    // leave a field undefined where a number is expected.
    expect(saved.agentMinutes).toBe(BEHAVIOUR_DEFAULTS.agentMinutes);
  });

  it("clamps rather than trusting", () => {
    // These govern spend and runaway loops: a typo must not be able to leave
    // an agent looping for a day.
    expect(parseBehaviour({ maxSteps: 100000 }).maxSteps).toBe(100);
    expect(parseBehaviour({ agentMinutes: 0 }).agentMinutes).toBe(1);
    expect(parseBehaviour({ approvalExpiryHours: 0 }).approvalExpiryHours).toBe(1);
    expect(parseBehaviour({ approvalExpiryHours: 9000 }).approvalExpiryHours).toBe(720);
    expect(parseBehaviour({}).approvalExpiryHours).toBe(24);
    expect(parseBehaviour({ agentMinutes: -5 }).agentMinutes).toBe(1);
    // Below an even chance is not a lean to act on; 100 is as near off as it goes.
    expect(parseBehaviour({ memoryDecideAbove: 10 }).memoryDecideAbove).toBe(50);
    expect(parseBehaviour({ memoryDecideAbove: 500 }).memoryDecideAbove).toBe(100);
    expect(parseBehaviour({}).memoryDecideAbove).toBe(80);
  });

  it("rounds, and ignores what is not a number", () => {
    expect(parseBehaviour({ maxSteps: 12.7 }).maxSteps).toBe(13);
    expect(parseBehaviour({ maxSteps: "20" }).maxSteps).toBe(
      BEHAVIOUR_DEFAULTS.maxSteps,
    );
    expect(parseBehaviour({ maxSteps: NaN }).maxSteps).toBe(
      BEHAVIOUR_DEFAULTS.maxSteps,
    );
  });

  it("allows turning self-prompting off entirely", () => {
    expect(parseBehaviour({ selfPromptsPerHour: 0 }).selfPromptsPerHour).toBe(0);
  });

});
