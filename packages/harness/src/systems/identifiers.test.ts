import { describe, expect, it } from "vitest";

import {
  assertIdentifier,
  isValidIdentifier,
  projectTable,
  slugify,
} from "./identifiers.js";

describe("isValidIdentifier", () => {
  it("accepts lowercase identifiers", () => {
    expect(isValidIdentifier("budget_tx")).toBe(true);
    expect(isValidIdentifier("a")).toBe(true);
  });

  it("rejects unsafe or malformed identifiers", () => {
    expect(isValidIdentifier("")).toBe(false);
    expect(isValidIdentifier("1abc")).toBe(false);
    expect(isValidIdentifier("Budget")).toBe(false);
    expect(isValidIdentifier("drop table")).toBe(false);
    expect(isValidIdentifier("tx;--")).toBe(false);
    expect(isValidIdentifier("a".repeat(64))).toBe(false);
  });
});

describe("assertIdentifier", () => {
  it("throws on injection-shaped input", () => {
    expect(() => assertIdentifier('tx"; DROP TABLE x; --')).toThrow(/invalid/);
  });
});

describe("slugify", () => {
  it("produces valid slugs from names", () => {
    expect(slugify("Budget 2026")).toBe("budget_2026");
    expect(slugify("  My Study Plan!! ")).toBe("my_study_plan");
  });

  it("prefixes slugs that would start with a digit", () => {
    expect(slugify("2026 budget")).toBe("p_2026_budget");
  });

  it("falls back for empty input", () => {
    expect(slugify("!!!")).toBe("project");
  });
});

describe("projectTable", () => {
  it("namespaces a table under a project slug", () => {
    expect(projectTable("budget", "tx")).toBe("budget_tx");
  });

  it("rejects an unsafe table name", () => {
    expect(() => projectTable("budget", "tx; DROP")).toThrow(/invalid/);
  });
});
