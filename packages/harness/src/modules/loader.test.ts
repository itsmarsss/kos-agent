import { describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import {
  ModuleLoader,
  toolRegistryContext,
  type KosModule,
  type ModuleContext,
} from "./loader.js";
import { EventBus } from "./events.js";

function toolModule(name: string, toolName: string, version = "1.0.0"): KosModule {
  return {
    manifest: {
      name,
      version,
      provides: [{ kind: "tool", name: toolName, version }],
    },
    activate(ctx) {
      ctx.registerTool(
        { name: toolName, description: name, inputSchema: { type: "object" } },
        () => "ok",
      );
    },
  };
}

describe("ModuleLoader", () => {
  it("activates modules and registers their tools", async () => {
    const registry = new ToolRegistry();
    const loader = new ModuleLoader(toolRegistryContext(registry));
    const report = await loader.load([toolModule("budget", "add_tx")]);
    expect(report.loaded).toEqual(["budget"]);
    expect(report.failed).toEqual([]);
    expect(registry.has("add_tx")).toBe(true);
  });

  it("activates providers before dependents regardless of input order", async () => {
    const order: string[] = [];
    const noopCtx: ModuleContext = { registerTool: () => {} };
    const provider: KosModule = {
      manifest: {
        name: "provider",
        version: "1.0.0",
        provides: [{ kind: "tool", name: "base", version: "1.0.0" }],
      },
      activate() {
        order.push("provider");
      },
    };
    const dependent: KosModule = {
      manifest: {
        name: "dependent",
        version: "1.0.0",
        provides: [],
        needs: [{ kind: "tool", name: "base", range: "^1.0.0" }],
      },
      activate() {
        order.push("dependent");
      },
    };
    const loader = new ModuleLoader(noopCtx);
    const report = await loader.load([dependent, provider]);
    expect(report.loaded).toEqual(["provider", "dependent"]);
    expect(order).toEqual(["provider", "dependent"]);
  });

  it("disables a module whose dependency version is unmet", async () => {
    const loader = new ModuleLoader({ registerTool: () => {} });
    const dependent: KosModule = {
      manifest: {
        name: "dependent",
        version: "1.0.0",
        provides: [],
        needs: [{ kind: "tool", name: "base", range: "^2.0.0" }],
      },
      activate() {},
    };
    const report = await loader.load([toolModule("provider", "base", "1.0.0"), dependent]);
    expect(report.loaded).toEqual(["provider"]);
    expect(report.failed).toEqual([
      { name: "dependent", reason: "unsatisfied dependencies" },
    ]);
  });

  it("lets modules go in reverse order and reports one that will not", async () => {
    const order: string[] = [];
    const quiet = (name: string, fail = false): KosModule => ({
      manifest: { name, version: "1.0.0", provides: [] },
      activate() {},
      async deactivate() {
        order.push(name);
        if (fail) throw new Error(`${name} stuck`);
      },
    });
    const loader = new ModuleLoader(toolRegistryContext(new ToolRegistry()));
    await loader.load([quiet("first"), quiet("second", true), quiet("third")]);
    const failed = await loader.unload();
    expect(order).toEqual(["third", "second", "first"]);
    expect(failed).toEqual([{ name: "second", reason: "second stuck" }]);
    // Unloading again is nothing: what was let go is not held any more.
    expect(await loader.unload()).toEqual([]);
    expect(order).toHaveLength(3);
  });

  it("skips what the owner switched off, and switches a module off and on with its tools", async () => {
    const registry = new ToolRegistry();
    const loader = new ModuleLoader(toolRegistryContext(registry));
    const report = await loader.load([toolModule("tasks", "tasks.add"), toolModule("files", "files.read")], { skip: ["tasks"] });
    expect(report.loaded).toEqual(["files"]);
    expect(registry.has("tasks.add")).toBe(false);
    expect(loader.isActive("tasks")).toBe(false);
    expect(await loader.enable("tasks")).toBe(true);
    expect(registry.has("tasks.add")).toBe(true);
    expect(await loader.disable("tasks")).toBe(true);
    expect(registry.has("tasks.add")).toBe(false);
    expect(registry.has("files.read")).toBe(true);
    expect(await loader.disable("tasks")).toBe(false);
    expect(await loader.enable("ghost")).toBe(false);
  });

  it("isolates a throwing module and loads the rest", async () => {
    const registry = new ToolRegistry();
    const loader = new ModuleLoader(toolRegistryContext(registry));
    const bad: KosModule = {
      manifest: { name: "bad", version: "1.0.0", provides: [] },
      activate() {
        throw new Error("boom");
      },
    };
    const report = await loader.load([bad, toolModule("good", "good_tool")]);
    expect(report.loaded).toEqual(["good"]);
    expect(report.failed[0]).toMatchObject({ name: "bad", reason: "boom" });
    expect(registry.has("good_tool")).toBe(true);
  });

  it("cascades: a dependent of a failed module is also disabled", async () => {
    const loader = new ModuleLoader({ registerTool: () => {} });
    const failing: KosModule = {
      manifest: {
        name: "failing",
        version: "1.0.0",
        provides: [{ kind: "tool", name: "base", version: "1.0.0" }],
      },
      activate() {
        throw new Error("nope");
      },
    };
    const dependent: KosModule = {
      manifest: {
        name: "dependent",
        version: "1.0.0",
        provides: [],
        needs: [{ kind: "tool", name: "base", range: "*" }],
      },
      activate() {},
    };
    const report = await loader.load([failing, dependent]);
    expect(report.loaded).toEqual([]);
    expect(report.failed.map((f) => f.name).sort()).toEqual([
      "dependent",
      "failing",
    ]);
  });

  it("ends a module's subscriptions when it is switched off", async () => {
    const bus = new EventBus();
    const registry = new ToolRegistry();
    const loader = new ModuleLoader(toolRegistryContext(registry, undefined, bus));
    const heard: string[] = [];
    await loader.load([
      {
        manifest: { name: "listener", version: "1.0.0", provides: [] },
        activate(ctx) {
          ctx.events!.on("turn:end", (e) => {
      heard.push(e.conversationId);
    });
        },
      },
    ]);
    bus.emit({ kind: "turn:end", conversationId: "a", projectSlug: null });
    await loader.disable("listener");
    bus.emit({ kind: "turn:end", conversationId: "b", projectSlug: null });
    expect(heard).toEqual(["a"]);
    expect(bus.count()).toBe(0);
  });
});
