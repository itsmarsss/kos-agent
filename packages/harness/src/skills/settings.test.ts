import { describe, expect, it } from "vitest";

import { parseSkillSettings, withSkillEnabled, withSkillPromoted } from "./settings.js";

describe("skill settings", () => {
  it("reads what is off and what was promoted, and keeps each when the other changes", () => {
    expect(parseSkillSettings(undefined)).toEqual({ disabled: [], promoted: {} });
    expect(parseSkillSettings({ disabled: ["a", " a ", 3], promoted: { daily: "h1", bad: 3 } })).toEqual({ disabled: ["a"], promoted: { daily: "h1" } });
    const once = withSkillPromoted(parseSkillSettings({ disabled: ["b"] }), "daily", "h1");
    expect(once).toEqual({ disabled: ["b"], promoted: { daily: "h1" } });
    expect(withSkillPromoted(once, "daily", "h2").promoted).toEqual({ daily: "h2" });
    expect(withSkillEnabled(once, "b", true)).toEqual({ disabled: [], promoted: { daily: "h1" } });
    expect(withSkillEnabled(once, "daily", false)).toEqual({ disabled: ["b", "daily"], promoted: { daily: "h1" } });
  });

  it("ties no code to a promotion kept as a name alone", () => {
    expect(parseSkillSettings({ promoted: ["daily"] }).promoted).toEqual({});
  });
});
