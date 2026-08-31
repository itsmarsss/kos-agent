import { describe, expect, it } from "vitest";

import type { PageSpec } from "./pagespec.js";
import {
  isReadOnlyQuery,
  isValidPageSpec,
  validatePageSpec,
} from "./pagespec-validate.js";

describe("isReadOnlyQuery", () => {
  it("accepts single SELECT/WITH statements", () => {
    expect(isReadOnlyQuery("SELECT * FROM tx")).toBe(true);
    expect(isReadOnlyQuery("WITH a AS (SELECT 1) SELECT * FROM a")).toBe(true);
    expect(isReadOnlyQuery("SELECT * FROM tx;")).toBe(true);
  });

  it("rejects writes, DDL, and stacked statements", () => {
    expect(isReadOnlyQuery("DELETE FROM tx")).toBe(false);
    expect(isReadOnlyQuery("UPDATE tx SET x=1")).toBe(false);
    expect(isReadOnlyQuery("DROP TABLE tx")).toBe(false);
    expect(isReadOnlyQuery("SELECT 1; DROP TABLE tx")).toBe(false);
    expect(isReadOnlyQuery("PRAGMA table_info(tx)")).toBe(false);
  });
});

describe("validatePageSpec", () => {
  const valid: PageSpec = {
    id: "budget",
    title: "Budget Tracker",
    widgets: [
      { type: "stat", label: "Spent", query: "SELECT SUM(amount) FROM tx" },
      { type: "table", query: "SELECT * FROM tx ORDER BY date DESC" },
      { type: "chart", kind: "line", query: "SELECT week, SUM(amount) FROM tx GROUP BY week" },
      {
        type: "form",
        mutate: { table: "tx", columns: ["amount", "note"] },
      },
    ],
  };

  it("accepts a well-formed page", () => {
    expect(validatePageSpec(valid)).toEqual([]);
    expect(isValidPageSpec(valid)).toBe(true);
  });

  it("rejects a bad page id", () => {
    expect(validatePageSpec({ ...valid, id: "1Bad Id" })).toContain(
      "page id must match ^[a-z][a-z0-9_-]*$",
    );
  });

  it("flags an unknown widget type", () => {
    const spec = {
      ...valid,
      widgets: [{ type: "spreadsheet" } as unknown as PageSpec["widgets"][number]],
    };
    expect(validatePageSpec(spec).some((e) => e.includes("unknown widget type"))).toBe(
      true,
    );
  });

  it("rejects a non-read-only display query", () => {
    const spec: PageSpec = {
      ...valid,
      widgets: [{ type: "table", query: "DELETE FROM tx" }],
    };
    expect(validatePageSpec(spec).some((e) => e.includes("read-only"))).toBe(true);
  });

  it("requires a mutation target on a form", () => {
    const spec = {
      ...valid,
      widgets: [{ type: "form" } as unknown as PageSpec["widgets"][number]],
    };
    expect(
      validatePageSpec(spec).some((e) => e.includes("form requires a mutation target")),
    ).toBe(true);
  });

  it("validates a list/card mutation target when present", () => {
    const spec: PageSpec = {
      ...valid,
      widgets: [
        {
          type: "list",
          query: "SELECT * FROM todo",
          mutate: { table: "todo", columns: [] },
        },
      ],
    };
    expect(
      validatePageSpec(spec).some((e) => e.includes("at least one column")),
    ).toBe(true);
  });

  it("flags duplicate widget ids", () => {
    const spec: PageSpec = {
      ...valid,
      widgets: [
        { type: "markdown", id: "x", content: "a" },
        { type: "markdown", id: "x", content: "b" },
      ],
    };
    expect(
      validatePageSpec(spec).some((e) => e.includes("duplicate widget id")),
    ).toBe(true);
  });
});

describe("widget span", () => {
  const page = (w: unknown) => ({
    id: "p",
    title: "P",
    widgets: [w],
  }) as unknown as PageSpec;

  it("accepts each supported span", () => {
    for (const span of ["quarter", "third", "half", "full"]) {
      const errors = validatePageSpec(
        page({ type: "stat", label: "n", query: "SELECT 1", span }),
      );
      expect(errors).toEqual([]);
    }
  });

  it("treats span as optional", () => {
    expect(
      validatePageSpec(page({ type: "stat", label: "n", query: "SELECT 1" })),
    ).toEqual([]);
  });

  it("rejects an unknown span", () => {
    const errors = validatePageSpec(
      page({ type: "stat", label: "n", query: "SELECT 1", span: "enormous" }),
    );
    expect(errors.join(" ")).toMatch(/span must be one of/);
  });
});

describe("mutation ops", () => {
  const spec = (allow: unknown): unknown => ({
    id: "p",
    title: "P",
    widgets: [
      { type: "form", mutate: { table: "t", columns: ["a"], allow } },
    ],
  });

  it("accepts the real ops", () => {
    expect(validatePageSpec(spec(["insert", "delete"]) as never)).toEqual([]);
  });

  it("rejects an invented op and lists the real ones", () => {
    // "create" passed validation and then failed at submit time, so the page
    // looked correct right up until someone tried to use it.
    expect(validatePageSpec(spec(["create"]) as never).join(" ")).toContain(
      "insert, update, delete",
    );
  });
});
