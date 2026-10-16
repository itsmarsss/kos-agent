import { describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { ENGINE_TOOL, createBrowserModule, parseStep, stepCall } from "./browser.js";

/**
 * A visit is one call: open, wait, look. A run of steps is one call too,
 * each step one engine gesture, and the page handed back after. A bad step
 * is refused before anything runs; a failing one says what got done.
 */

function harness(answers: Record<string, string | Error> = {}) {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const registry = new ToolRegistry();
  const module = createBrowserModule({
    call: async (tool, args) => {
      calls.push({ tool, args });
      const a = answers[tool];
      if (a instanceof Error) throw a;
      return a ?? "";
    },
  });
  return { calls, registry, module };
}

describe("browser.visit", () => {
  it("opens, waits, and hands back the title and an interactive snapshot", async () => {
    const h = harness({ [ENGINE_TOOL.title]: "Example Domain\n", [ENGINE_TOOL.snapshot]: '- link "More" [ref=e1]' });
    await h.module.activate({ registerTool: (d, f, r, m) => h.registry.register(d, f, r, m) });
    const result = await h.registry.execute("browser.visit", { url: "https://example.com" });
    expect(result.isError).toBe(false);
    expect(result.content).toBe('Opened https://example.com\nTitle: Example Domain\n- link "More" [ref=e1]');
    expect(h.calls.map((c) => c.tool)).toEqual([ENGINE_TOOL.open, ENGINE_TOOL.waitForLoad, ENGINE_TOOL.title, ENGINE_TOOL.snapshot]);
    expect(h.calls[3]?.args).toEqual({ interactive: true, compact: true });
    expect(h.registry.classify("browser.visit", {}).tier).toBe("safe");
  });

  it("reads the page as text when asked, and scopes a snapshot to a selector", async () => {
    const h = harness({ [ENGINE_TOOL.read]: "# Article\n\nWords." });
    await h.module.activate({ registerTool: (d, f, r, m) => h.registry.register(d, f, r, m) });
    const read = await h.registry.execute("browser.visit", { url: "https://a.example/post", then: "read" });
    expect(read.content).toBe("Opened https://a.example/post\n# Article\n\nWords.");
    expect(h.calls.map((c) => c.tool)).toEqual([ENGINE_TOOL.open, ENGINE_TOOL.waitForLoad, ENGINE_TOOL.read]);
    h.calls.length = 0;
    await h.registry.execute("browser.visit", { url: "https://a.example/", scope: "main" });
    expect(h.calls.at(-1)?.args).toEqual({ interactive: true, compact: true, selector: "main" });
  });
});

describe("browser.act", () => {
  it("runs the steps in order as engine calls, then looks", async () => {
    const h = harness({ [ENGINE_TOOL.snapshot]: "- after" });
    await h.module.activate({ registerTool: (d, f, r, m) => h.registry.register(d, f, r, m) });
    const result = await h.registry.execute("browser.act", {
      steps: [{ fill: { selector: "@e2", text: "jane" } }, { select: { selector: "@e3", values: ["ca"] } }, { check: "@e4" }, { click: "@e5" }, { wait: 500 }, { scroll: "down" }, { press: "Enter" }],
    });
    expect(result.isError).toBe(false);
    expect(h.calls.map((c) => c.tool)).toEqual([ENGINE_TOOL.fill, ENGINE_TOOL.select, ENGINE_TOOL.check, ENGINE_TOOL.click, ENGINE_TOOL.waitMs, ENGINE_TOOL.scroll, ENGINE_TOOL.press, ENGINE_TOOL.title, ENGINE_TOOL.snapshot]);
    expect(h.calls[0]?.args).toEqual({ selector: "@e2", text: "jane" });
    expect(h.calls[1]?.args).toEqual({ selector: "@e3", values: ["ca"] });
    expect(result.content).toBe("Done: filled @e2; selected ca in @e3; checked @e4; clicked @e5; waited 500ms; scrolled down; pressed Enter.\n- after");
    expect(h.registry.classify("browser.act", {}).tier).toBe("risky");
  });

  it("refuses a malformed step before running any, and says where a run stopped", async () => {
    const h = harness({ [ENGINE_TOOL.click]: new Error("no element @e9") });
    await h.module.activate({ registerTool: (d, f, r, m) => h.registry.register(d, f, r, m) });
    const bad = await h.registry.execute("browser.act", { steps: [{ click: "@e1" }, { jump: "x" }] });
    expect(bad.isError).toBe(true);
    expect(bad.content).toMatch(/step 2: must have exactly one of/);
    expect(h.calls).toHaveLength(0);
    const failed = await h.registry.execute("browser.act", { steps: [{ press: "Tab" }, { click: "@e9" }, { press: "Enter" }] });
    expect(failed.isError).toBe(true);
    expect(failed.content).toBe("tool error: Done: pressed Tab. Step 2 failed (clicked): no element @e9");
    expect(h.calls.map((c) => c.tool)).toEqual([ENGINE_TOOL.press, ENGINE_TOOL.click]);
  });

  it("checks each step's shape", () => {
    expect(parseStep({ open: "https://x" }, 0)).toEqual({ open: "https://x" });
    expect(parseStep({ select: { selector: "@e1", value: "a" } }, 0)).toEqual({ select: { selector: "@e1", values: ["a"] } });
    expect(() => parseStep({ scroll: "sideways" }, 2)).toThrow(/step 3: scroll wants/);
    expect(() => parseStep({ wait: 99_999 }, 0)).toThrow(/up to 30000/);
    expect(() => parseStep({ fill: { selector: "@e1" } }, 0)).toThrow(/fill wants \{selector, text\}/);
    expect(() => parseStep("click", 0)).toThrow(/must be an object/);
    expect(stepCall({ type: { selector: "@e1", text: "hi" } })).toEqual({ tool: ENGINE_TOOL.type, args: { selector: "@e1", text: "hi" }, said: "typed into @e1" });
  });
});

describe("browser.handoff", () => {
  it("is risky, and once the owner has done it hands back where the tab is", async () => {
    const h = harness({ [ENGINE_TOOL.url]: "https://bank.example/home\n", [ENGINE_TOOL.title]: "Home" });
    await h.module.activate({ registerTool: (d, f, r, m) => h.registry.register(d, f, r, m) });
    expect(h.registry.classify("browser.handoff", { reason: "log in" }).tier).toBe("risky");
    const result = await h.registry.execute("browser.handoff", { reason: "log in" });
    expect(result.content).toBe("The owner has done it. The tab is now at https://bank.example/home (Home). Look again before you act.");
  });
});

describe("browser.look", () => {
  it("hands back the tab as a picture, or says there is none", async () => {
    const h = harness();
    let shot: { data: string } | undefined = { data: "AAAA" };
    const module = createBrowserModule({ call: async () => "", look: async () => shot });
    await module.activate({ registerTool: (d, f, r, m) => h.registry.register(d, f, r, m) });
    expect(await h.registry.execute("browser.look", {})).toEqual({ content: "The tab as it is now.", isError: false, images: [{ mediaType: "image/jpeg", data: "AAAA" }] });
    expect(h.registry.classify("browser.look", {}).tier).toBe("safe");
    shot = undefined;
    expect((await h.registry.execute("browser.look", {})).content).toMatch(/no tab to look at/);
  });
});
