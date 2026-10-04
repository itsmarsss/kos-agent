import { describe, expect, it } from "vitest";

import { isTheme, resolveTheme } from "./theme.js";

describe("the theme choice", () => {
  it("lands dark or light on its own, and follows the system when asked", () => {
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("system", true)).toBe("light");
    expect(resolveTheme("system", false)).toBe("dark");
  });

  it("treats anything else stored as the default", () => {
    expect(isTheme("light")).toBe(true);
    expect(isTheme("sepia")).toBe(false);
    expect(isTheme(null)).toBe(false);
  });
});
