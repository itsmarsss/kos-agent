import { z } from "zod";

/**
 * KOS tool schemas, in the shape the Claude Agent SDK wants.
 *
 * Tools here are declared as JSON Schema, which is what the model providers
 * take. The SDK's in-process MCP server takes a Zod shape instead, so running
 * a chat turn through it means translating one to the other.
 *
 * Deliberately narrow: it covers the shapes the registry actually uses and
 * falls back to "anything" rather than guessing. The tools validate their own
 * arguments regardless, so a loose translation costs the model a clear
 * description, not the workspace its safety.
 */

interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
}

function leaf(schema: JsonSchema): z.ZodTypeAny {
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  if (schema.enum && schema.enum.length > 0) {
    const literals = schema.enum.filter(
      (v): v is string => typeof v === "string",
    );
    // Only when every value is a string: a mixed enum is not something Zod's
    // enum can express, and a wrong translation is worse than a loose one.
    if (literals.length === schema.enum.length) {
      return z.enum(literals as [string, ...string[]]);
    }
    return z.unknown();
  }

  switch (type) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "integer":
      return z.number().int();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(schema.items ? leaf(schema.items) : z.unknown());
    case "object":
      return schema.properties
        ? z.object(shapeOf(schema))
        : z.record(z.string(), z.unknown());
    default:
      return z.unknown();
  }
}

function shapeOf(schema: JsonSchema): z.ZodRawShape {
  const shape: Record<string, z.ZodTypeAny> = {};
  const required = new Set(schema.required ?? []);
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    let field = leaf(property);
    if (property.description) field = field.describe(property.description);
    shape[name] = required.has(name) ? field : field.optional();
  }
  return shape;
}

/**
 * The Zod shape for a tool's input schema. An input that is not an object
 * with properties yields an empty shape, which the SDK reads as a tool that
 * takes nothing.
 */
export function toZodShape(input: unknown): z.ZodRawShape {
  if (typeof input !== "object" || input === null) return {};
  return shapeOf(input as JsonSchema);
}
