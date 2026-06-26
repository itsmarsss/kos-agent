import { describe, expect, it } from "vitest";

import { classifyRisk, RISKY, SAFE, type ToolRisk } from "./tiers.js";

describe("classifyRisk", () => {
  it("treats a missing risk as safe", () => {
    expect(classifyRisk(undefined, {})).toEqual({ tier: "safe", escalated: false });
  });

  it("keeps a safe floor safe with no escalation", () => {
    expect(classifyRisk(SAFE, { anything: 1 })).toEqual({
      tier: "safe",
      escalated: false,
    });
  });

  it("treats a risky floor as risky regardless of args", () => {
    expect(classifyRisk(RISKY, {})).toEqual({ tier: "risky", escalated: false });
  });

  it("escalates a safe floor when the rule fires", () => {
    const risk: ToolRisk = { floor: "safe", escalate: (i) => i.danger === true };
    expect(classifyRisk(risk, { danger: true })).toEqual({
      tier: "risky",
      escalated: true,
    });
    expect(classifyRisk(risk, { danger: false })).toEqual({
      tier: "safe",
      escalated: false,
    });
  });

  it("does not consult escalation when the floor is already risky", () => {
    let called = false;
    const risk: ToolRisk = {
      floor: "risky",
      escalate: () => {
        called = true;
        return true;
      },
    };
    classifyRisk(risk, {});
    expect(called).toBe(false);
  });
});
