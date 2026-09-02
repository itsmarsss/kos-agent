import { describe, expect, it } from "vitest";
import { z } from "zod";

import { toZodShape } from "./schema.js";

/** Parse through the translated shape, the way the SDK will. */
function check(schema: unknown, input: unknown): unknown {
  return z.object(toZodShape(schema)).parse(input);
}

describe("translating a tool schema", () => {
  const files = {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path" },
      lines: { type: "integer" },
    },
    required: ["path"],
  };

  it("keeps required and optional apart", () => {
    expect(check(files, { path: "a.md" })).toEqual({ path: "a.md" });
    expect(() => check(files, {})).toThrow();
  });

  it("carries the description, which is what the model reads", () => {
    const shape = toZodShape(files) as Record<string, { description?: string }>;
    expect(shape["path"]?.description).toBe("Workspace-relative path");
  });

  it("handles the shapes the registry actually uses", () => {
    const spec = {
      type: "object",
      properties: {
        name: { type: "string" },
        count: { type: "number" },
        on: { type: "boolean" },
        tags: { type: "array", items: { type: "string" } },
        nested: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
      required: ["name"],
    };
    const value = {
      name: "x",
      count: 2,
      on: true,
      tags: ["a", "b"],
      nested: { id: "1" },
    };
    expect(check(spec, value)).toEqual(value);
  });

  it("reads a string enum as a choice", () => {
    const spec = {
      type: "object",
      properties: { kind: { type: "string", enum: ["fact", "preference"] } },
      required: ["kind"],
    };
    expect(check(spec, { kind: "fact" })).toEqual({ kind: "fact" });
    expect(() => check(spec, { kind: "other" })).toThrow();
  });

  it("passes through what it cannot express rather than guessing", () => {
    // A mixed enum, and a property with no type. The tools validate their own
    // arguments, so a loose translation costs a description, not safety.
    const spec = {
      type: "object",
      properties: {
        mixed: { enum: [1, "two"] },
        anything: {},
      },
    };
    expect(check(spec, { mixed: 1, anything: { a: 1 } })).toEqual({
      mixed: 1,
      anything: { a: 1 },
    });
  });

  it("is empty for a tool that takes nothing", () => {
    expect(toZodShape(undefined)).toEqual({});
    expect(toZodShape({ type: "object" })).toEqual({});
  });

  it("allows an object with no declared properties to hold anything", () => {
    const spec = {
      type: "object",
      properties: { args: { type: "object" } },
      required: ["args"],
    };
    expect(check(spec, { args: { whatever: true } })).toEqual({
      args: { whatever: true },
    });
  });
});
