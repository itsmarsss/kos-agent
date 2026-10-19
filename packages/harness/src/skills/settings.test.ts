import { describe, expect, it } from "vitest";

import { parseSkillSettings, withSkillEnabled, withSkillPromoted } from "./settings.js";

describe("skill settings", () => {
  it("reads what is off and what was promoted, and keeps each when the other changes", () => {
    expect(parseSkillSettings(undefined)).toEqual({ disabled: [], promoted: [] });
    expect(parseSkillSettings({ disabled: ["a", " a ", 3], promoted: ["daily"] })).toEqual({ disabled: ["a"], promoted: ["daily"] });
    const once = withSkillPromoted(parseSkillSettings({ disabled: ["b"] }), "daily");
    expect(once).toEqual({ disabled: ["b"], promoted: ["daily"] });
    expect(withSkillPromoted(once, "daily")).toEqual(once);
    expect(withSkillEnabled(once, "b", true)).toEqual({ disabled: [], promoted: ["daily"] });
    expect(withSkillEnabled(once, "daily", false)).toEqual({ disabled: ["b", "daily"], promoted: ["daily"] });
  });
});
