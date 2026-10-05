import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { toolRegistryContext } from "../modules/loader.js";
import { SuggestionStore } from "../improve/store.js";
import { Workspace } from "../store/workspace.js";
import { createImproveModule } from "./improve.js";

describe("improve tools", () => {
  let root: string;
  let ws: Workspace;
  let registry: ToolRegistry;
  let suggestions: SuggestionStore;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-improve-"));
    ws = Workspace.open(root);
    registry = new ToolRegistry();
    suggestions = new SuggestionStore(ws.db);
    await createImproveModule({ suggestions }).activate(toolRegistryContext(registry));
  });
  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("raises a suggestion the owner will see, and lists the open ones", async () => {
    const made = JSON.parse((await registry.execute("improve.suggest", { kind: "blueprint", title: "Make the pantry a module", detail: "three pantry-shaped projects", action: "Promote pantry." })).content);
    expect(made).toMatchObject({ kind: "blueprint", title: "Make the pantry a module" });
    expect(suggestions.pending()).toHaveLength(1);
    const listed = JSON.parse((await registry.execute("improve.list", {})).content);
    expect(listed.open).toEqual([{ kind: "blueprint", title: "Make the pantry a module" }]);
  });

  it("creates nothing: both tools are safe", () => {
    expect(registry.classify("improve.suggest", {}).tier).toBe("safe");
    expect(registry.classify("improve.list", {}).tier).toBe("safe");
  });
});
