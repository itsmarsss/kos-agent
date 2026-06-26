import { describe, expect, it } from "vitest";

import type { ToolDef } from "../models/types.js";
import { ToolRegistry } from "./registry.js";

const echoDef: ToolDef = {
  name: "echo",
  description: "echoes input",
  inputSchema: { type: "object", properties: { msg: { type: "string" } } },
};

describe("ToolRegistry", () => {
  it("registers and exposes tool defs", () => {
    const reg = new ToolRegistry();
    reg.register(echoDef, (input) => String(input.msg));
    expect(reg.has("echo")).toBe(true);
    expect(reg.defs()).toEqual([echoDef]);
  });

  it("rejects duplicate registration", () => {
    const reg = new ToolRegistry();
    reg.register(echoDef, () => "x");
    expect(() => reg.register(echoDef, () => "y")).toThrow(/already registered/);
  });

  it("executes a tool and returns its result", async () => {
    const reg = new ToolRegistry();
    reg.register(echoDef, (input) => `got ${input.msg}`);
    expect(await reg.execute("echo", { msg: "hi" })).toEqual({
      content: "got hi",
      isError: false,
    });
  });

  it("returns an error result for an unknown tool", async () => {
    const reg = new ToolRegistry();
    const res = await reg.execute("missing", {});
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/unknown tool/);
  });

  it("converts a handler throw into an error result", async () => {
    const reg = new ToolRegistry();
    reg.register(echoDef, () => {
      throw new Error("boom");
    });
    const res = await reg.execute("echo", {});
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/boom/);
  });
});
