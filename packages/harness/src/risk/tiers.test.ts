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

  it("says why, in the rule's own words or the floor's", () => {
    const rule: ToolRisk = { floor: "safe", escalate: (i) => (i.open ? "lets Members in" : false) };
    expect(classifyRisk(rule, { open: true })).toEqual({ tier: "risky", escalated: true, reason: "lets Members in" });
    expect(classifyRisk(rule, { open: false })).toEqual({ tier: "safe", escalated: false });
    expect(classifyRisk({ floor: "risky", why: "deletes it for good" }, {})).toEqual({ tier: "risky", escalated: false, reason: "deletes it for good" });
  });

  it("relaxes a risky floor only when the rule proves the call harmless", () => {
    const risk: ToolRisk = { floor: "risky", relax: (i) => i.reads === true };
    expect(classifyRisk(risk, { reads: true })).toEqual({ tier: "safe", escalated: false });
    expect(classifyRisk(risk, { reads: false })).toEqual({ tier: "risky", escalated: false });
    expect(classifyRisk(risk, {})).toEqual({ tier: "risky", escalated: false });
    // Relaxation is for a risky floor; a safe one has nothing to relax.
    let called = false;
    classifyRisk({ floor: "safe", relax: () => (called = true) }, {});
    expect(called).toBe(false);
  });

  it("carries a refusal rule, which the tier does not consult", () => {
    // A refusal is the registry's to apply before the tier; the tier itself is unchanged by it.
    const risk: ToolRisk = { floor: "risky", refuse: (input) => (input["path"] === "kos.sqlite" ? "not that file" : false) };
    expect(classifyRisk(risk, { path: "kos.sqlite" }).tier).toBe("risky");
    expect(risk.refuse?.({ path: "kos.sqlite" })).toBe("not that file");
    expect(risk.refuse?.({ path: "notes.md" })).toBe(false);
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
